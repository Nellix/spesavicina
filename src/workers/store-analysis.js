import { migrate, pool, transaction } from "../db.js";
import { claimEvent, completeEvent, failEvent } from "../outbox.js";
import { sleep, startHealthServer } from "../worker-runtime.js";

const SERVICE = "store-analysis-worker";
const status = { processed: 0, errors: 0, lastProcessedAt: null };
const OVERPASS_URL = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "development-only";
const INGESTORS = {
  carrefour: process.env.CARREFOUR_INGESTOR_URL ?? "http://carrefour-ingestor",
  esselunga: process.env.ESSELUNGA_INGESTOR_URL ?? "http://esselunga-ingestor",
  ekom: process.env.EKOM_INGESTOR_URL ?? "http://ekom-ingestor",
  coop: process.env.COOP_INGESTOR_URL ?? "http://coop-ingestor",
  lidl: process.env.LIDL_INGESTOR_URL ?? "http://lidl-ingestor",
  ins: process.env.INS_INGESTOR_URL ?? "http://ins-ingestor",
  conad: process.env.CONAD_INGESTOR_URL ?? "http://conad-ingestor",
  md: process.env.MD_INGESTOR_URL ?? "http://md-ingestor",
  pam: process.env.PAM_INGESTOR_URL ?? "http://pam-ingestor",
  borello: process.env.BORELLO_INGESTOR_URL ?? "http://borello-ingestor",
  crai: process.env.CRAI_INGESTOR_URL ?? "http://crai-ingestor",
  mercato: process.env.MERCATO_INGESTOR_URL ?? "http://mercato-ingestor",
};

function radians(value) { return value * Math.PI / 180; }
function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = radians(bLat - aLat); const dLon = radians(bLon - aLon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)) * 100) / 100;
}

function logoKey(value = "") {
  const name = value.toLowerCase();
  if (name.includes("carrefour")) return "carrefour";
  if (name.includes("esselunga")) return "esselunga";
  if (name.includes("ipercoop") || name.includes("coop")) return "coop";
  if (name.includes("conad")) return "conad";
  if (name.includes("pam")) return "pam";
  if (name.includes("in's") || name.includes("ins mercato")) return "ins";
  if (name.includes("ekom")) return "ekom";
  if (name.includes("mercatò") || name.includes("mercato")) return "mercato";
  if (name.includes("borello")) return "borello";
  if (name.includes("lidl")) return "lidl";
  if (/\bmd\b/.test(name) || name.includes("md discount")) return "md";
  if (name.includes("eurospin")) return "eurospin";
  if (name.includes("crai")) return "crai";
  return "market";
}

function retailerName(name, brand) {
  const key = logoKey(`${brand ?? ""} ${name ?? ""}`);
  const names = { carrefour: "Carrefour", esselunga: "Esselunga", coop: "Coop", conad: "Conad", pam: "Pam", ins: "IN'S", ekom: "Ekom", mercato: "Mercatò", borello: "Borello", lidl: "Lidl", md: "MD", eurospin: "Eurospin", crai: "Crai" };
  return names[key] ?? (brand || name || "Supermarket");
}

function supportedCollector(retailer) {
  const key = logoKey(retailer);
  return INGESTORS[key] ? key : null;
}

async function notification(client, profileId, type, title, message, data = {}) {
  await client.query(`INSERT INTO service_notifications(profile_id,type,title,message,data) VALUES ($1,$2,$3,$4,$5)`, [profileId, type, title, message, data]);
}

async function discoverNearby(event) {
  const jobId = Number(event.payload.jobId ?? event.aggregate_id);
  const latitude = Number(event.payload.latitude); const longitude = Number(event.payload.longitude);
  const job = await pool.query(`SELECT j.profile_id,p.discovery_radius_km FROM store_analysis_jobs j JOIN profiles p ON p.id=j.profile_id WHERE j.id=$1`, [jobId]);
  if (!job.rowCount) throw new Error(`Analysis job ${jobId} no longer exists`);
  const profileId = Number(job.rows[0].profile_id);
  const profile = job;
  const radiusKm = Math.min(25, Math.max(0.5, Number(event.payload.radiusKm ?? profile.rows[0]?.discovery_radius_km ?? 3)));
  const radiusMetres = Math.round(radiusKm * 1000);
  await pool.query(`UPDATE store_analysis_jobs SET status='running',started_at=COALESCE(started_at,now()),error=NULL WHERE id=$1`, [jobId]);
  const query = `[out:json][timeout:30];(nwr[shop=supermarket](around:${radiusMetres},${latitude},${longitude});nwr[shop=convenience](around:${radiusMetres},${latitude},${longitude}););out center tags;`;
  const response = await fetch(OVERPASS_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "SpesaVicina/1.0 (nearby-store discovery)" }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Nearby-store provider returned ${response.status}`);
  const data = await response.json();
  const discovered = (data.elements ?? []).map((element) => {
    const tags = element.tags ?? {}; const lat = Number(element.lat ?? element.center?.lat); const lon = Number(element.lon ?? element.center?.lon);
    const name = tags.name ?? tags.brand;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const retailer = retailerName(name, tags.brand);
    const addressParts = [[tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "), tags["addr:city"] ?? "Torino"].filter(Boolean);
    return { id: `osm-${element.type}-${element.id}`, externalId: `osm:${element.type}:${element.id}`, retailer, name, address: addressParts.join(", ") || "Address available on map", latitude: lat, longitude: lon, distanceKm: distanceKm(latitude, longitude, lat, lon), logoKey: logoKey(retailer), sourceUrl: tags.website ?? tags["contact:website"] ?? null };
  }).filter((store) => store && store.distanceKm <= radiusKm).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 100);

  let displayAddress = null;
  try {
    const reverse = await fetch(`${NOMINATIM_URL}/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=18`, { headers: { "user-agent": "SpesaVicina/1.0 (location label)" }, signal: AbortSignal.timeout(12_000) });
    if (reverse.ok) displayAddress = (await reverse.json()).display_name;
  } catch { /* Store discovery must not fail because reverse geocoding is unavailable. */ }

  await transaction(async (client) => {
    for (const store of discovered) {
      await client.query(`
        INSERT INTO stores(id,external_id,retailer,name,address,latitude,longitude,distance_km,source_type,logo_key,source_url,discovered_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        ON CONFLICT(id) DO UPDATE SET retailer=EXCLUDED.retailer,name=EXCLUDED.name,address=EXCLUDED.address,
          latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,distance_km=EXCLUDED.distance_km,logo_key=EXCLUDED.logo_key,
          source_url=COALESCE(EXCLUDED.source_url,stores.source_url),discovered_at=now()
      `, [store.id, store.externalId, store.retailer, store.name, store.address, store.latitude, store.longitude, store.distanceKm, supportedCollector(store.retailer) ? "live" : "discovery", store.logoKey, store.sourceUrl]);
      await client.query(`INSERT INTO profile_stores(profile_id,store_id,selected,distance_km) VALUES ($1,$2,false,$3) ON CONFLICT(profile_id,store_id) DO UPDATE SET distance_km=EXCLUDED.distance_km`, [profileId, store.id, store.distanceKm]);
    }
    if (displayAddress) await client.query(`UPDATE profiles SET address=$1,updated_at=now() WHERE id=$2`, [displayAddress, profileId]);
    await client.query(`UPDATE store_analysis_jobs SET status='completed',result=$1,finished_at=now() WHERE id=$2`, [{ storesFound: discovered.length, radiusKm }, jobId]);
    await notification(client, profileId, "nearby_stores_ready", "Nearby stores are ready", `We found ${discovered.length} grocery stores within ${radiusKm} km. Choose the ones worth a trip and we’ll analyse their offers.`, { jobId, storesFound: discovered.length, radiusKm });
  });
  return discovered.length;
}

async function analyzeStore(event) {
  const jobId = Number(event.payload.jobId ?? event.aggregate_id); const storeId = String(event.payload.storeId);
  const job = await pool.query(`SELECT profile_id FROM store_analysis_jobs WHERE id=$1`, [jobId]);
  if (!job.rowCount) throw new Error(`Analysis job ${jobId} no longer exists`);
  const profileId = Number(job.rows[0].profile_id);
  const found = await pool.query(`SELECT * FROM stores WHERE id=$1`, [storeId]);
  if (!found.rowCount) throw new Error(`Store ${storeId} no longer exists`);
  const store = found.rows[0]; const collector = supportedCollector(store.retailer);
  await pool.query(`UPDATE store_analysis_jobs SET status='running',started_at=COALESCE(started_at,now()),error=NULL WHERE id=$1`, [jobId]);
  await pool.query(`UPDATE stores SET analysis_status='running' WHERE id=$1`, [storeId]);
  if (!collector) {
    await transaction(async (client) => {
      await client.query(`UPDATE stores SET analysis_status='unsupported',offers_last_analyzed_at=now() WHERE id=$1`, [storeId]);
      await client.query(`UPDATE store_analysis_jobs SET status='completed',result=$1,finished_at=now() WHERE id=$2`, [{ supported: false }, jobId]);
      await notification(client, profileId, "store_analysis_ready", `${store.name} saved`, "This store is now on your nearby list. Automated offer collection is not available for this retailer yet.", { jobId, storeId, supported: false });
    });
    return 0;
  }
  const analysisTimeoutMs = Number(process.env.STORE_ANALYSIS_TIMEOUT_MS ?? 960_000);
  const response = await fetch(`${INGESTORS[collector]}/analyze`, { method: "POST", headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ store: { id: store.id, retailer: store.retailer, name: store.name, address: store.address, sourceUrl: store.source_url } }), signal: AbortSignal.timeout(analysisTimeoutMs) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `${collector} collector returned ${response.status}`);
  await transaction(async (client) => {
    await client.query(`UPDATE stores SET analysis_status=$1,offers_last_analyzed_at=now(),source_url=COALESCE($2,source_url) WHERE id=$3`, [result.configured ? "ready" : "unsupported", result.sourceUrl || null, storeId]);
    await client.query(`UPDATE store_analysis_jobs SET status='completed',result=$1,finished_at=now() WHERE id=$2`, [result, jobId]);
    await client.query(`UPDATE service_notifications SET read_at=now() WHERE profile_id=$1 AND type='store_analysis_ready' AND data->>'storeId'=$2 AND read_at IS NULL`, [profileId, storeId]);
    const message = result.configured
      ? `${result.offersFound ?? 0} live offers were checked. Exact matches will appear automatically when they clear your saving threshold.`
      : "The store is saved, but its exact official offer page was not published in the store directory yet. We’ll retry when the source becomes available.";
    await notification(client, profileId, "store_analysis_ready", `${store.name} analysis is ready`, message, { jobId, storeId, offersFound: result.offersFound ?? 0, configured: result.configured });
  });
  return Number(result.offersFound ?? 0);
}

async function permanentlyFail(event, error) {
  const jobId = Number(event.payload.jobId ?? event.aggregate_id); const storeId = event.payload.storeId;
  await transaction(async (client) => {
    const job = await client.query(`SELECT profile_id FROM store_analysis_jobs WHERE id=$1`, [jobId]);
    if (!job.rowCount) return;
    const profileId = Number(job.rows[0].profile_id);
    await client.query(`UPDATE store_analysis_jobs SET status='failed',error=$1,finished_at=now() WHERE id=$2`, [error.message.slice(0, 1000), jobId]);
    if (storeId) await client.query(`UPDATE stores SET analysis_status='failed' WHERE id=$1`, [storeId]);
    await notification(client, profileId, "analysis_failed", "Store analysis needs another try", "The retailer source was temporarily unavailable. You can retry by selecting the store again.", { jobId, storeId });
  });
}

let lastSweepAt = 0;
async function scheduleDueAnalyses() {
  if (Date.now() - lastSweepAt < 60_000) return;
  lastSweepAt = Date.now();
  const { rows } = await pool.query(`
    SELECT ps.profile_id,s.id FROM stores s JOIN profile_stores ps ON ps.store_id=s.id AND ps.selected=true
    WHERE s.enabled=true AND lower(s.retailer) IN ('carrefour','esselunga','ekom','coop','lidl','in''s','ins','conad','md','pam','borello','crai','mercatò','mercato')
      AND (s.offers_last_analyzed_at IS NULL OR s.offers_last_analyzed_at < now()-interval '6 hours')
      AND NOT EXISTS (SELECT 1 FROM store_analysis_jobs j WHERE j.profile_id=ps.profile_id AND j.store_id=s.id AND j.kind='offer_analysis' AND j.status IN ('queued','running'))
    LIMIT 10
  `);
  for (const row of rows) {
    await transaction(async (client) => {
      const job = await client.query(`INSERT INTO store_analysis_jobs(profile_id,store_id,kind,request) VALUES ($1,$2,'offer_analysis',$3) RETURNING id`, [row.profile_id, row.id, { storeId: row.id, scheduled: true }]);
      await client.query(`UPDATE stores SET analysis_status='queued' WHERE id=$1`, [row.id]);
      await client.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload) VALUES ('store.analysis.requested','analysis_job',$1,$2)`, [String(job.rows[0].id), { jobId: Number(job.rows[0].id), storeId: row.id, profileId: Number(row.profile_id) }]);
    });
  }
}

async function run() {
  await migrate(); startHealthServer(SERVICE, status);
  console.log(JSON.stringify({ level: "info", service: SERVICE, message: "event loop started" }));
  while (true) {
    await scheduleDueAnalyses();
    const event = await claimEvent(["store.discovery.requested", "store.analysis.requested"]);
    if (!event) { await sleep(750); continue; }
    try {
      const count = event.event_type === "store.discovery.requested" ? await discoverNearby(event) : await analyzeStore(event);
      await completeEvent(event.id); status.processed += 1; status.lastProcessedAt = new Date().toISOString();
      console.log(JSON.stringify({ level: "info", service: SERVICE, eventId: event.id, eventType: event.event_type, count }));
    } catch (error) {
      status.errors += 1;
      if (event.attempts >= 3) { await permanentlyFail(event, error); await completeEvent(event.id); }
      else await failEvent(event, error);
      console.error(JSON.stringify({ level: "error", service: SERVICE, eventId: event.id, attempt: event.attempts, message: error.message }));
    }
  }
}

run().catch((error) => { console.error(JSON.stringify({ level: "fatal", service: SERVICE, message: error.message })); process.exit(1); });
