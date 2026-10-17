import { pool, transaction } from "./db.js";
import { CANONICAL_PRODUCTS, DEMO_STORES } from "./catalogue.js";
import { demoOffers, prepareOffer } from "../server/connectors.js";
import { normalize, productSearchScore, productSearchTokens, slug } from "../server/domain.js";

function number(value) {
  return value === null || value === undefined ? null : Number(value);
}

function isoDate(value) {
  return value?.toISOString?.().slice(0, 10) ?? value ?? null;
}

function storeDistanceKm(left, right) {
  const toRadians = (value) => Number(value) * Math.PI / 180;
  const dLat = toRadians(Number(right.latitude) - Number(left.latitude));
  const dLon = toRadians(Number(right.longitude) - Number(left.longitude));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(left.latitude)) * Math.cos(toRadians(right.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function storeQuality(row) {
  return (row.selected ? 100 : 0) + (row.analysis_status === "ready" ? 50 : 0) + (row.source_url ? 20 : 0) + (row.address && row.address !== "Torino" ? 5 : 0);
}

function storeStreet(row) {
  const firstPart = String(row.address ?? "").split(",")[0];
  const street = normalize(firstPart).replace(/\b\d+[a-z]?\b/g, "").replace(/\s+/g, " ").trim();
  return ["", "torino", "address available on map"].includes(street) ? "" : street;
}

function reliableStore(row) {
  return Boolean(row.selected || row.analysis_status === "ready" || storeStreet(row));
}

export function deduplicateStores(rows) {
  const unique = [];
  for (const row of rows) {
    const rowStreet = storeStreet(row);
    const index = unique.findIndex((candidate) => {
      if (normalize(candidate.retailer) !== normalize(row.retailer)) return false;
      const samePoint = storeDistanceKm(candidate, row) <= 0.08;
      const sameStreet = rowStreet && rowStreet === storeStreet(candidate) && storeDistanceKm(candidate, row) <= 1.2;
      return samePoint || sameStreet;
    });
    if (index < 0) unique.push(row);
    else if (storeQuality(row) > storeQuality(unique[index])) unique[index] = row;
  }
  const groups = new Map();
  for (const row of unique) {
    const key = normalize(row.retailer);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const reconciled = [...groups.values()].flatMap((group) => {
    const reliable = group.filter(reliableStore);
    return group.length > 2 && reliable.length >= 2 ? reliable : group;
  });
  return reconciled.sort((left, right) => Number(left.distance_km) - Number(right.distance_km));
}

function toProduct(row) {
  return {
    id: row.id,
    brand: row.brand,
    productName: row.product_name,
    variant: row.variant,
    packSize: row.pack_size,
    category: row.category,
    aliases: row.aliases ?? [],
    currentBestPrice: number(row.current_best_price),
    activeOfferCount: Number(row.active_offer_count ?? 0),
    storeCount: Number(row.store_count ?? 0),
    imageUrl: row.current_image_url ?? null,
    lastPromotionDate: isoDate(row.last_promotion_date),
  };
}

function toOffer(row) {
  const price = number(row.price);
  const listPrice = number(row.list_price);
  const validity = isoDate(row.valid_until);
  return {
    id: Number(row.id),
    productId: row.product_id,
    sourceId: row.source_id,
    retailer: row.retailer,
    storeId: row.store_id,
    productName: row.product_name,
    brand: row.brand,
    variant: row.variant,
    packSize: row.pack_size,
    price,
    listPrice,
    unitPrice: row.unit_price,
    condition: row.condition_text,
    validFrom: isoDate(row.valid_from),
    validUntil: validity,
    lastPromotionDate: validity ?? isoDate(row.last_seen_at),
    lastSeenAt: row.last_seen_at,
    sourceUrl: row.source_url,
    imageUrl: row.source_evidence?.imageUrl ?? null,
    confidence: number(row.confidence),
    status: row.status,
    ...(row.is_current === undefined ? {} : { isCurrent: Boolean(row.is_current) }),
    saving: row.matched_saving !== undefined ? number(row.matched_saving) : Math.max(0, Math.round(((listPrice ?? price) - price) * 100) / 100),
  };
}

async function emit(client, eventType, aggregateType, aggregateId, payload = {}) {
  await client.query(`INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`, [eventType, aggregateType, String(aggregateId), payload]);
}

async function upsertProduct(client, product) {
  const searchText = productSearchTokens([product.brand, product.productName, product.variant, product.packSize, ...(product.aliases ?? [])].join(" ")).join(" ");
  await client.query(`
    INSERT INTO products(id, brand, product_name, variant, pack_size, category, search_text)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(id) DO UPDATE SET brand=EXCLUDED.brand, product_name=EXCLUDED.product_name, variant=EXCLUDED.variant,
      pack_size=EXCLUDED.pack_size, category=EXCLUDED.category, search_text=EXCLUDED.search_text, updated_at=now()
  `, [product.id, product.brand, product.productName, product.variant ?? "", product.packSize ?? "", product.category ?? "Other", searchText]);
  for (const alias of product.aliases ?? []) {
    const normalized = productSearchTokens(alias).join(" ");
    await client.query(`
      INSERT INTO product_aliases(product_id, alias, normalized_alias) VALUES ($1,$2,$3)
      ON CONFLICT(normalized_alias) DO UPDATE SET product_id=EXCLUDED.product_id, alias=EXCLUDED.alias
    `, [product.id, alias, normalized]);
  }
  return product.id;
}

async function allProducts(client = pool) {
  const { rows } = await client.query(`
    SELECT p.*,
      COALESCE(alias_data.aliases, '{}') AS aliases,
      offer_data.current_best_price,
      COALESCE(offer_data.active_offer_count, 0) AS active_offer_count,
      COALESCE(offer_data.store_count, 0) AS store_count,
      offer_data.current_image_url,
      offer_data.last_promotion_date
    FROM products p
    LEFT JOIN LATERAL (
      SELECT array_agg(pa.alias ORDER BY pa.alias) AS aliases
      FROM product_aliases pa
      WHERE pa.product_id=p.id
    ) alias_data ON true
    LEFT JOIN LATERAL (
      SELECT
        MIN(o.price) FILTER (WHERE o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)) AS current_best_price,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)) AS active_offer_count,
        COUNT(DISTINCT o.store_id) FILTER (WHERE o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)) AS store_count,
        (array_agg(NULLIF(o.source_evidence->>'imageUrl','') ORDER BY
          (o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)) DESC,
          o.valid_until DESC NULLS LAST,
          o.last_seen_at DESC
        ) FILTER (WHERE NULLIF(o.source_evidence->>'imageUrl','') IS NOT NULL))[1] AS current_image_url,
        MAX(o.valid_until) FILTER (WHERE o.status IN ('approved','expired') AND o.valid_until < CURRENT_DATE) AS last_promotion_date
      FROM offers o
      WHERE o.product_id=p.id AND o.status IN ('approved','expired')
    ) offer_data ON true
    WHERE p.status='active'
    ORDER BY p.brand, p.product_name
  `);
  return rows.map(toProduct);
}

export async function searchProducts(query, limit = 8, client = pool) {
  const products = await allProducts(client);
  return products
    .map((product) => ({ product, score: productSearchScore(query, product) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.product.activeOfferCount - left.product.activeOfferCount)
    .slice(0, limit)
    .map(({ product, score }) => ({ ...product, score }));
}

function identifierKey(identifier) {
  return `${identifier.scheme}|${identifier.retailer ?? ""}|${identifier.value}`;
}

async function ingestionContext(client) {
  const [products, identifiers] = await Promise.all([
    client.query(`
      SELECT p.*,COALESCE(array_agg(pa.alias ORDER BY pa.alias) FILTER (WHERE pa.alias IS NOT NULL),'{}') AS aliases
      FROM products p LEFT JOIN product_aliases pa ON pa.product_id=p.id
      WHERE p.status='active'
      GROUP BY p.id
    `),
    client.query(`SELECT scheme,retailer,value,product_id FROM product_identifiers`),
  ]);
  return {
    products: products.rows.map((row) => ({
      id: row.id, brand: row.brand, productName: row.product_name, variant: row.variant,
      packSize: row.pack_size, category: row.category, aliases: row.aliases ?? [], activeOfferCount: 0,
    })),
    identifiers: new Map(identifiers.rows.map((row) => [identifierKey(row), row.product_id])),
  };
}

async function resolveProduct(client, offer, allowCreate, context = null) {
  if (offer.productId) {
    if (context?.products.some((product) => product.id === offer.productId)) return offer.productId;
    if (!context) {
      const found = await client.query(`SELECT id FROM products WHERE id=$1`, [offer.productId]);
      if (found.rowCount) return offer.productId;
    }
  }
  const identifiers = offer.identifiers ?? [];
  for (const identifier of identifiers) {
    if (context?.identifiers.has(identifierKey(identifier))) return context.identifiers.get(identifierKey(identifier));
    if (context) continue;
    const found = await client.query(`SELECT product_id FROM product_identifiers WHERE scheme=$1 AND retailer=$2 AND value=$3`, [identifier.scheme, identifier.retailer ?? "", identifier.value]);
    if (found.rowCount) return found.rows[0].product_id;
  }
  if (!allowCreate) return null;
  const query = `${offer.brand} ${offer.productName} ${offer.variant ?? ""} ${offer.packSize ?? ""}`;
  const candidates = context
    ? context.products.map((product) => ({ product, score: productSearchScore(query, product) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 4)
      .map(({ product, score }) => ({ ...product, score }))
    : await searchProducts(query, 4, client);
  const candidate = candidates.find((item) => item.score >= 35);
  if (candidate) return candidate.id;
  const id = slug(`${offer.brand}-${offer.productName}-${offer.variant ?? ""}-${offer.packSize ?? ""}`);
  const product = { id, brand: offer.brand, productName: offer.productName, variant: offer.variant ?? "", packSize: offer.packSize ?? "", category: "Other", aliases: [], activeOfferCount: 0 };
  await upsertProduct(client, product);
  if (context && !context.products.some((item) => item.id === id)) context.products.push(product);
  return id;
}

async function ingestWithClient(client, rawOffers, source, diagnostics = [], snapshot = {}) {
  const run = await client.query(`INSERT INTO ingestion_runs(source,status) VALUES ($1,'running') RETURNING id`, [source]);
  const context = await ingestionContext(client);
  let reviewCount = 0;
  let imported = 0;
  let expired = 0;
  const seenSourceIds = [];
  try {
    for (const raw of rawOffers) {
      const offer = prepareOffer(raw);
      if (!offer.storeId || !offer.retailer || !offer.productName || !offer.brand || !Number.isFinite(Number(offer.price))) continue;
      const productId = await resolveProduct(client, offer, offer.status === "approved", context);
      seenSourceIds.push(offer.sourceId);
      if (productId) {
        for (const identifier of offer.identifiers ?? []) {
          await client.query(`
            INSERT INTO product_identifiers(product_id,scheme,retailer,value) VALUES ($1,$2,$3,$4)
            ON CONFLICT(scheme,retailer,value) DO UPDATE SET product_id=EXCLUDED.product_id
          `, [productId, identifier.scheme, identifier.retailer ?? "", String(identifier.value)]);
          context.identifiers.set(identifierKey(identifier), productId);
        }
      }
      if (offer.status === "review") reviewCount += 1;
      const result = await client.query(`
        INSERT INTO offers(source_id,retailer,store_id,product_id,product_name,brand,variant,pack_size,price,list_price,unit_price,
          condition_text,valid_from,valid_until,source_url,source_evidence,confidence,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT(retailer,source_id) DO UPDATE SET store_id=EXCLUDED.store_id, product_id=EXCLUDED.product_id,
          product_name=EXCLUDED.product_name, brand=EXCLUDED.brand, variant=EXCLUDED.variant, pack_size=EXCLUDED.pack_size,
          price=EXCLUDED.price, list_price=EXCLUDED.list_price, unit_price=EXCLUDED.unit_price,
          condition_text=EXCLUDED.condition_text, valid_from=EXCLUDED.valid_from, valid_until=EXCLUDED.valid_until,
          source_url=EXCLUDED.source_url, source_evidence=EXCLUDED.source_evidence, confidence=EXCLUDED.confidence,
          status=EXCLUDED.status, last_seen_at=now()
        RETURNING id
      `, [offer.sourceId, offer.retailer, offer.storeId, productId, offer.productName, offer.brand, offer.variant ?? "", offer.packSize ?? "", Number(offer.price), offer.listPrice ?? null, offer.unitPrice ?? "", offer.condition ?? "", offer.validFrom ?? null, offer.validUntil ?? null, offer.sourceUrl, offer.sourceEvidence ?? {}, Number(offer.confidence ?? 0), offer.status ?? "review"]);
      imported += 1;
      await emit(client, "offer.changed", "offer", result.rows[0].id, { offerId: Number(result.rows[0].id) });
    }
    if (snapshot.complete && seenSourceIds.length && Array.isArray(snapshot.storeIds) && snapshot.storeIds.length) {
      const reconciled = await client.query(`
        UPDATE offers SET status='expired',valid_until=COALESCE(valid_until,last_seen_at::date)
        WHERE lower(retailer)=lower($1) AND store_id=ANY($2::text[]) AND status IN ('approved','review')
          AND (valid_from IS NULL OR valid_from<=CURRENT_DATE)
          AND NOT(source_id=ANY($3::text[])) AND last_seen_at<now()
        RETURNING id
      `, [snapshot.retailer, snapshot.storeIds, seenSourceIds]);
      expired = reconciled.rowCount;
      for (const row of reconciled.rows) await emit(client, "offer.changed", "offer", row.id, { offerId: Number(row.id), expired: true });
    }
    await client.query(`UPDATE ingestion_runs SET status='success', offers_found=$1, review_count=$2, diagnostics=$3, finished_at=now() WHERE id=$4`, [imported, reviewCount, JSON.stringify(diagnostics), run.rows[0].id]);
    return { offersFound: imported, reviewCount, expiredCount: expired, runId: Number(run.rows[0].id) };
  } catch (error) {
    throw Object.assign(error, { ingestionRunId: run.rows[0].id });
  }
}

export async function ingestOffers(rawOffers, source, diagnostics = [], snapshot = {}) {
  try {
    return await transaction((client) => ingestWithClient(client, rawOffers, source, diagnostics, snapshot));
  } catch (error) {
    await pool.query(`INSERT INTO ingestion_runs(source,status,message,diagnostics,finished_at) VALUES ($1,'failed',$2,$3,now())`, [source, error.message.slice(0, 1000), JSON.stringify(diagnostics)]);
    throw error;
  }
}

export async function seedData() {
  await transaction(async (client) => {
    await client.query(`INSERT INTO profiles(id,name,email,postcode,address,default_min_saving) VALUES (1,'Nello','demo@spesavicina.local','10153','Corso Belgio 74, Torino',1) ON CONFLICT(id) DO NOTHING`);
    for (const store of DEMO_STORES) {
      await client.query(`
        INSERT INTO stores(id,retailer,name,address,latitude,longitude,distance_km,source_type,logo_key,source_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(id) DO UPDATE SET retailer=EXCLUDED.retailer,name=EXCLUDED.name,address=EXCLUDED.address,
          latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,distance_km=EXCLUDED.distance_km,source_type=EXCLUDED.source_type,
          logo_key=EXCLUDED.logo_key,source_url=COALESCE(stores.source_url,EXCLUDED.source_url)
      `, [store.id, store.retailer, store.name, store.address, store.latitude, store.longitude, store.distanceKm, store.sourceType, store.logoKey ?? "market", store.sourceUrl ?? null]);
      await client.query(`INSERT INTO profile_stores(profile_id,store_id,selected) VALUES (1,$1,true) ON CONFLICT DO NOTHING`, [store.id]);
    }
    for (const product of CANONICAL_PRODUCTS) await upsertProduct(client, product);
    const watchCount = await client.query(`SELECT count(*)::int AS count FROM watch_items WHERE profile_id=1`);
    if (!watchCount.rows[0].count) {
      for (const [productId, minSaving] of [["santanna-acqua-naturale-6x1-5l", 1], ["lavazza-qualita-rossa-2x250g", 1], ["barilla-spaghetti-n5-500g", 0.3]]) {
        await client.query(`INSERT INTO watch_items(profile_id,product_id,min_saving) VALUES (1,$1,$2) ON CONFLICT DO NOTHING`, [productId, minSaving]);
      }
    }
    const offerCount = await client.query(`SELECT count(*)::int AS count FROM offers`);
    if (!offerCount.rows[0].count) await ingestWithClient(client, demoOffers, "demo-seed", [{ source: "embedded", count: demoOffers.length }]);
    await emit(client, "catalogue.seeded", "catalogue", "global", {});
  });
}

export async function bootstrap(profileId) {
  await pool.query(`
    INSERT INTO profile_stores(profile_id,store_id,selected,distance_km)
    SELECT $1,s.id,false,0 FROM stores s WHERE s.enabled=true AND s.source_type='online'
    ON CONFLICT(profile_id,store_id) DO NOTHING
  `, [profileId]);
  const [profile, stores, watches, notifications, offers, stats, analysisJobs, serviceNotifications] = await Promise.all([
    pool.query(`SELECT id,email,name,postcode,address,default_min_saving AS "defaultMinSaving",discovery_radius_km AS "discoveryRadiusKm",latitude,longitude,location_accuracy AS "locationAccuracy",geolocated_at AS "geolocatedAt",is_admin AS "isAdmin" FROM profiles WHERE id=$1`, [profileId]),
    pool.query(`SELECT s.*,COALESCE(ps.distance_km,s.distance_km) AS distance_km,ps.selected FROM stores s JOIN profiles p ON p.id=$1 JOIN profile_stores ps ON ps.store_id=s.id AND ps.profile_id=p.id WHERE s.enabled=true AND (s.source_type='online' OR COALESCE(ps.distance_km,s.distance_km) <= p.discovery_radius_km OR ps.selected=true) ORDER BY (s.source_type='online'),COALESCE(ps.distance_km,s.distance_km)`, [profileId]),
    pool.query(`SELECT w.id,w.product_id AS "productId",p.brand,concat_ws(' ',p.product_name,NULLIF(p.variant,'')) AS "productName",p.pack_size AS "packSize",w.min_saving AS "minSaving",w.active,w.created_at AS "createdAt",
      (SELECT o.source_evidence->>'imageUrl' FROM offers o WHERE o.product_id=p.id AND o.status IN ('approved','expired') AND NULLIF(o.source_evidence->>'imageUrl','') IS NOT NULL ORDER BY (o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)) DESC,o.valid_until DESC NULLS LAST,o.last_seen_at DESC LIMIT 1) AS "imageUrl",
      (SELECT MAX(o.valid_until) FROM offers o WHERE o.product_id=p.id AND o.status IN ('approved','expired')) AS "lastPromotionDate"
      FROM watch_items w JOIN products p ON p.id=w.product_id WHERE w.profile_id=$1 ORDER BY w.active DESC,w.created_at DESC`, [profileId]),
    pool.query(`SELECT n.id AS notification_id,m.saving AS matched_saving,m.reason AS match_reason,n.created_at AS notified_at,o.*,s.name AS store_name,f.value AS feedback FROM notifications n JOIN matches m ON m.id=n.match_id JOIN offers o ON o.id=m.offer_id JOIN stores s ON s.id=o.store_id LEFT JOIN feedback f ON f.notification_id=n.id AND f.profile_id=n.profile_id WHERE n.profile_id=$1 ORDER BY n.created_at DESC`, [profileId]),
    pool.query(`WITH ranked_offers AS (
      SELECT o.*,s.name AS store_name,
        (o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)) AS is_current,
        ROW_NUMBER() OVER (PARTITION BY o.product_id ORDER BY
          (o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)) DESC,
          CASE WHEN o.status='approved' AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE) AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE) THEN o.price END ASC NULLS LAST,
          o.valid_until DESC NULLS LAST,
          o.last_seen_at DESC
        ) AS product_rank
      FROM offers o
      JOIN stores s ON s.id=o.store_id
      WHERE o.product_id IS NOT NULL AND o.status IN ('approved','expired')
        AND (o.status='expired' OR o.valid_from IS NULL OR o.valid_from<=CURRENT_DATE)
    )
    SELECT * FROM ranked_offers WHERE product_rank=1
    ORDER BY is_current DESC,
      CASE WHEN is_current THEN valid_until END ASC NULLS LAST,
      COALESCE(valid_until,last_seen_at::date) DESC,
      brand,product_name`),
    pool.query(`SELECT (SELECT count(*) FROM watch_items WHERE profile_id=$1 AND active=true)::int AS active_watches,(SELECT count(*) FROM matches WHERE profile_id=$1)::int AS matches,(SELECT COALESCE(sum(saving),0) FROM matches WHERE profile_id=$1)::numeric AS potential_savings`, [profileId]),
    pool.query(`SELECT id,store_id AS "storeId",kind,status,request,result,error,created_at AS "createdAt",started_at AS "startedAt",finished_at AS "finishedAt" FROM store_analysis_jobs WHERE profile_id=$1 ORDER BY created_at DESC LIMIT 20`, [profileId]),
    pool.query(`SELECT id,type,title,message,data,read_at AS "readAt",created_at AS "createdAt" FROM service_notifications WHERE profile_id=$1 ORDER BY created_at DESC LIMIT 20`, [profileId]),
  ]);
  if (!profile.rowCount) throw Object.assign(new Error("Shopping profile is not initialized"), { status: 503 });
  return {
    user: { ...profile.rows[0], id: Number(profile.rows[0].id), defaultMinSaving: number(profile.rows[0].defaultMinSaving), discoveryRadiusKm: number(profile.rows[0].discoveryRadiusKm), isAdmin: Boolean(profile.rows[0].isAdmin) },
    stores: deduplicateStores(stores.rows).map((row) => ({ id: row.id, retailer: row.retailer, name: row.name, address: row.address, latitude: row.latitude, longitude: row.longitude, distanceKm: number(row.distance_km), sourceType: row.source_type, sourceUrl: row.source_url, logoKey: row.logo_key, analysisStatus: row.analysis_status, offersLastAnalyzedAt: row.offers_last_analyzed_at, selected: row.selected })),
    watches: watches.rows.map((row) => ({ ...row, id: Number(row.id), minSaving: number(row.minSaving) })),
    notifications: notifications.rows.map((row) => ({ ...toOffer(row), notificationId: Number(row.notification_id), saving: number(row.matched_saving), matchReason: row.match_reason, notifiedAt: row.notified_at, storeName: row.store_name, feedback: row.feedback })),
    offers: offers.rows.map((row) => ({ ...toOffer(row), storeName: row.store_name })),
    analysisJobs: analysisJobs.rows.map((row) => ({ ...row, id: Number(row.id) })),
    serviceNotifications: serviceNotifications.rows.map((row) => ({ ...row, id: Number(row.id) })),
    stats: { activeWatches: stats.rows[0].active_watches, matches: stats.rows[0].matches, potentialSavings: number(stats.rows[0].potential_savings) },
  };
}

export async function createWatch(profileId, productId, minSaving) {
  return transaction(async (client) => {
    const product = await client.query(`SELECT id FROM products WHERE id=$1 AND status='active'`, [productId]);
    if (!product.rowCount) throw Object.assign(new Error("Select a product from the catalogue."), { status: 422 });
    try {
      const created = await client.query(`INSERT INTO watch_items(profile_id,product_id,min_saving) VALUES ($1,$2,$3) RETURNING id`, [profileId, productId, minSaving]);
      await emit(client, "watch.changed", "watch", created.rows[0].id, { watchId: Number(created.rows[0].id) });
      return Number(created.rows[0].id);
    } catch (error) {
      if (error.code === "23505") throw Object.assign(new Error("You already track this product."), { status: 409 });
      throw error;
    }
  });
}

export async function updateWatch(profileId, id, input) {
  return transaction(async (client) => {
    const current = await client.query(`SELECT * FROM watch_items WHERE id=$1 AND profile_id=$2`, [id, profileId]);
    if (!current.rowCount) throw Object.assign(new Error("Watch item not found."), { status: 404 });
    const minSaving = input.minSaving === undefined ? current.rows[0].min_saving : Number(input.minSaving);
    const active = input.active === undefined ? current.rows[0].active : Boolean(input.active);
    if (!Number.isFinite(Number(minSaving)) || Number(minSaving) < 0) throw Object.assign(new Error("Saving threshold must be zero or more."), { status: 422 });
    await client.query(`UPDATE watch_items SET min_saving=$1,active=$2,updated_at=now() WHERE id=$3`, [minSaving, active, id]);
    await emit(client, "watch.changed", "watch", id, { watchId: Number(id) });
  });
}

export async function deleteWatch(profileId, id) {
  await pool.query(`DELETE FROM watch_items WHERE id=$1 AND profile_id=$2`, [id, profileId]);
}

export async function updateStore(profileId, id, selected) {
  return transaction(async (client) => {
    const found = await client.query(`SELECT * FROM stores WHERE id=$1 AND enabled=true`, [id]);
    if (!found.rowCount) throw Object.assign(new Error("Store not found."), { status: 404 });
    await client.query(`INSERT INTO profile_stores(profile_id,store_id,selected) VALUES ($1,$2,$3) ON CONFLICT(profile_id,store_id) DO UPDATE SET selected=EXCLUDED.selected`, [profileId, id, Boolean(selected)]);
    await emit(client, "store.changed", "store", id, { storeId: id });
    const stale = found.rows[0].analysis_status !== "ready" || !found.rows[0].offers_last_analyzed_at || Date.now() - new Date(found.rows[0].offers_last_analyzed_at).getTime() > 6 * 60 * 60_000;
    if (!selected || !stale) return { analysisStarted: false };
    let job;
    try {
      job = await client.query(`INSERT INTO store_analysis_jobs(profile_id,store_id,kind,request) VALUES ($1,$2,'offer_analysis',$3) RETURNING id`, [profileId, id, { storeId: id }]);
    } catch (error) {
      if (error.code !== "23505") throw error;
      job = await client.query(`SELECT id FROM store_analysis_jobs WHERE profile_id=$1 AND store_id=$2 AND kind='offer_analysis' AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`, [profileId, id]);
    }
    await client.query(`UPDATE stores SET analysis_status='queued' WHERE id=$1`, [id]);
    await emit(client, "store.analysis.requested", "analysis_job", job.rows[0].id, { jobId: Number(job.rows[0].id), storeId: id });
    return { analysisStarted: true, jobId: Number(job.rows[0].id) };
  });
}

async function queueDiscovery(client, profileId, profile, accuracy = null) {
  let job;
  try {
    job = await client.query(`INSERT INTO store_analysis_jobs(profile_id,kind,request) VALUES ($1,'nearby_discovery',$2) RETURNING id`, [profileId, { latitude: Number(profile.latitude), longitude: Number(profile.longitude), accuracy, radiusKm: Number(profile.discovery_radius_km) }]);
  } catch (error) {
    if (error.code !== "23505") throw error;
    job = await client.query(`SELECT id FROM store_analysis_jobs WHERE profile_id=$1 AND kind='nearby_discovery' AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`, [profileId]);
  }
  await emit(client, "store.discovery.requested", "analysis_job", job.rows[0].id, { jobId: Number(job.rows[0].id), latitude: Number(profile.latitude), longitude: Number(profile.longitude), radiusKm: Number(profile.discovery_radius_km) });
  return { jobId: Number(job.rows[0].id), status: "queued" };
}

export async function setLocation(profileId, latitude, longitude, accuracy = null) {
  return transaction(async (client) => {
    const profile = await client.query(`UPDATE profiles SET latitude=$1,longitude=$2,location_accuracy=$3,geolocated_at=now(),updated_at=now() WHERE id=$4 RETURNING *`, [latitude, longitude, accuracy, profileId]);
    return queueDiscovery(client, profileId, profile.rows[0], accuracy);
  });
}

export async function readServiceNotification(profileId, id) {
  const result = await pool.query(`UPDATE service_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND profile_id=$2 RETURNING id`, [id, profileId]);
  if (!result.rowCount) throw Object.assign(new Error("Notification not found."), { status: 404 });
}

export async function updateSettings(profileId, input) {
  return transaction(async (client) => {
    const current = await client.query(`SELECT * FROM profiles WHERE id=$1`, [profileId]);
    if (!current.rowCount) throw Object.assign(new Error("Profile not found."), { status: 404 });
    const threshold = Number(input.defaultMinSaving ?? current.rows[0].default_min_saving);
    const radiusKm = Number(input.discoveryRadiusKm ?? current.rows[0].discovery_radius_km);
    if (!Number.isFinite(threshold) || threshold < 0) throw Object.assign(new Error("Saving threshold must be zero or more."), { status: 422 });
    if (!Number.isFinite(radiusKm) || radiusKm < 0.5 || radiusKm > 25) throw Object.assign(new Error("Discovery radius must be between 0.5 and 25 km."), { status: 422 });
    const changedRadius = radiusKm !== Number(current.rows[0].discovery_radius_km);
    const saved = await client.query(`UPDATE profiles SET name=$1,address=$2,postcode=$3,default_min_saving=$4,discovery_radius_km=$5,updated_at=now() WHERE id=$6 RETURNING *`, [String(input.name ?? current.rows[0].name).trim(), String(input.address ?? current.rows[0].address).trim(), String(input.postcode ?? current.rows[0].postcode).trim(), threshold, radiusKm, profileId]);
    if (changedRadius && saved.rows[0].latitude != null && saved.rows[0].longitude != null) return { discoveryStarted: true, ...await queueDiscovery(client, profileId, saved.rows[0], saved.rows[0].location_accuracy) };
    return { discoveryStarted: false };
  });
}

export async function saveFeedback(profileId, notificationId, value) {
  const result = await pool.query(`INSERT INTO feedback(profile_id,notification_id,value) SELECT $1,n.id,$3 FROM notifications n WHERE n.id=$2 AND n.profile_id=$1 ON CONFLICT(profile_id,notification_id) DO UPDATE SET value=EXCLUDED.value,created_at=now() RETURNING id`, [profileId, notificationId, value]);
  if (!result.rowCount) throw Object.assign(new Error("Notification not found."), { status: 404 });
}

export async function adminState() {
  const [reviews, runs, queue] = await Promise.all([
    pool.query(`SELECT o.*,s.name AS store_name FROM offers o JOIN stores s ON s.id=o.store_id WHERE o.status='review' ORDER BY o.last_seen_at DESC`),
    pool.query(`SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT 30`),
    pool.query(`SELECT event_type,count(*)::int AS count FROM outbox_events WHERE processed_at IS NULL GROUP BY event_type ORDER BY event_type`),
  ]);
  return { reviews: reviews.rows.map((row) => ({ ...toOffer(row), storeName: row.store_name })), runs: runs.rows, queue: queue.rows };
}

export async function reviewOffer(id, status) {
  await transaction(async (client) => {
    const found = await client.query(`SELECT * FROM offers WHERE id=$1`, [id]);
    if (!found.rowCount) throw Object.assign(new Error("Offer not found."), { status: 404 });
    let productId = found.rows[0].product_id;
    if (status === "approved" && !productId) {
      productId = await resolveProduct(client, { productName: found.rows[0].product_name, brand: found.rows[0].brand, variant: found.rows[0].variant, packSize: found.rows[0].pack_size }, true);
    }
    await client.query(`UPDATE offers SET status=$1,product_id=$2,last_seen_at=now() WHERE id=$3`, [status, productId, id]);
    await emit(client, "offer.changed", "offer", id, { offerId: Number(id) });
  });
}

export async function exportProfile(profileId) {
  return bootstrap(profileId);
}
