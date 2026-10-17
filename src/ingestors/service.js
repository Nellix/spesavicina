import { createServer } from "node:http";
import { fetchLiveOffers } from "../../server/connectors.js";

const RETAILER = String(process.env.RETAILER ?? "").toLowerCase();
const FLYER_RETAILERS = new Set(["ins", "conad", "md", "pam", "borello", "crai", "mercato"]);
if (!["carrefour", "esselunga", "ekom", "coop", "lidl", ...FLYER_RETAILERS].includes(RETAILER)) throw new Error("Unsupported RETAILER");
const SERVICE = `${RETAILER}-ingestor`;
const PORT = Number(process.env.PORT ?? 8080);
const API_URL = process.env.API_URL ?? "http://spesavicina-api";
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "development-only";
const status = { runs: 0, errors: 0, lastRunAt: null, lastOfferCount: 0 };

function json(response, code, value) {
  response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function requireService(request) {
  if (request.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) throw Object.assign(new Error("Service authorization required"), { status: 401 });
}

async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 128_000) throw Object.assign(new Error("Request body too large"), { status: 413 }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

function carrefourFlyerUrl(sourceUrl) {
  if (!sourceUrl) return "";
  if (sourceUrl.includes("/volantino/")) return sourceUrl;
  const url = new URL(sourceUrl);
  const match = url.pathname.match(/^\/punti-vendita\/(.+)-(\d+)\.html$/i);
  return match ? `${url.origin}/volantino/${match[1]}/${match[2]}` : "";
}

function officialFlyerSource(retailer, storeUrl) {
  if (!storeUrl) return "";
  const patterns = {
    ins: /insmercato\.it\/volantino/i,
    conad: /conad\.it\/(?:ricerca-negozi|volantini)\//i,
    md: /mdspa\.it\/(?:volantino|punti-vendita)\//i,
    pam: /pampanorama\.it\/(?:volantino|negozi)\//i,
    borello: /borellosupermercati\.it\/volantino\//i,
    crai: /crai\.it\/negozi-e-volantini\//i,
    mercato: /mymercato\.it\/punti-vendita\//i,
  };
  return patterns[retailer]?.test(storeUrl) ? storeUrl : "";
}

async function runIngestion(store = null) {
  const defaultEsselungaUrl = process.env.ESSELUNGA_PROMOTIONS_URL || "https://www.esselunga.it/it-it/promozioni/volantini.esselunga-di-torino-porta-nuova.top.html";
  const sourceUrl = RETAILER === "carrefour"
    ? (store ? carrefourFlyerUrl(store.sourceUrl) : process.env.CARREFOUR_FLYER_URL ?? "")
    : RETAILER === "esselunga"
      ? (store?.sourceUrl?.includes("esselunga.it") ? store.sourceUrl : defaultEsselungaUrl)
      : RETAILER === "ekom"
        ? (process.env.EKOM_OFFERS_URL || "https://www.ekomdiscount.it/leaflet")
        : RETAILER === "coop"
          ? (store?.sourceUrl?.includes("coop.it") ? store.sourceUrl : process.env.COOP_STORE_URL ?? "")
          : RETAILER === "lidl"
            ? (process.env.LIDL_OFFERS_URL || "https://www.lidl.it/c/c1150")
            : (officialFlyerSource(RETAILER, store?.sourceUrl) || process.env[`${RETAILER.toUpperCase()}_FLYER_URL`] || "");
  const env = RETAILER === "carrefour"
    ? { CARREFOUR_FLYER_URL: sourceUrl, CARREFOUR_STORE_ID: store?.id ?? process.env.CARREFOUR_STORE_ID }
    : RETAILER === "esselunga"
      ? { ESSELUNGA_PROMOTIONS_URL: sourceUrl, ESSELUNGA_STORE_ID: store?.id ?? process.env.ESSELUNGA_STORE_ID }
      : RETAILER === "ekom"
        ? { EKOM_API_URL: process.env.EKOM_API_URL || "https://www.ekomdiscount.it/ebsn/api", EKOM_OFFERS_URL: sourceUrl, EKOM_STORE_ID: store?.id ?? process.env.EKOM_STORE_ID, EKOM_REGION: process.env.EKOM_REGION || "PIEMONTE" }
        : RETAILER === "coop"
          ? { COOP_STORE_URL: sourceUrl, COOP_STORE_ID: store?.id ?? process.env.COOP_STORE_ID }
          : RETAILER === "lidl"
            ? { LIDL_OFFERS_URL: sourceUrl, LIDL_STORE_ID: store?.id ?? process.env.LIDL_STORE_ID, LIDL_REGION_ID: process.env.LIDL_REGION_ID || "41000" }
            : {
                FLYER_RETAILER: RETAILER,
                FLYER_SOURCE_URL: sourceUrl,
                FLYER_STORE_ID: store?.id ?? process.env[`${RETAILER.toUpperCase()}_STORE_ID`] ?? RETAILER,
              };
  env.OCR_URL = process.env.OCR_URL ?? "";
  env.OCR_REQUEST_TIMEOUT_MS = process.env.OCR_REQUEST_TIMEOUT_MS ?? "900000";
  env.SERVICE_TOKEN = SERVICE_TOKEN;
  let result;
  if (!sourceUrl) {
    result = { offers: [], diagnostics: [{ retailer: RETAILER, storeId: store?.id, count: 0, status: "source_not_discovered" }] };
  } else {
    result = await fetchLiveOffers(env);
  }
  const completeSnapshot = result.offers.length > 0 && !result.diagnostics.some((item) => item.status);
  const configured = Boolean(sourceUrl) && !result.diagnostics.some((item) => item.status === "credentials_missing" || item.status === "source_not_discovered");
  const response = await fetch(`${API_URL}/internal/ingestions/offers`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      source: SERVICE,
      offers: result.offers,
      diagnostics: result.diagnostics,
      snapshot: { complete: completeSnapshot, retailer: result.offers[0]?.retailer ?? RETAILER, storeIds: [...new Set(result.offers.map((offer) => offer.storeId).filter(Boolean))] },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const saved = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`API ingestion failed: ${saved.error ?? response.status}`);
  status.runs += 1;
  status.lastRunAt = new Date().toISOString();
  status.lastOfferCount = result.offers.length;
  return { retailer: RETAILER, storeId: store?.id, sourceUrl, configured, ...saved, diagnostics: result.diagnostics };
}

function errorContext(error) {
  const causes = [];
  let current = error;
  while (current && causes.length < 5) {
    causes.push({ name: current.name, message: current.message, code: current.code });
    current = current.cause;
  }
  return causes;
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz" || request.url === "/readyz") return json(response, 200, { status: "ok", service: SERVICE, ...status });
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return response.end(`spesavicina_ingestion_runs_total{retailer="${RETAILER}"} ${status.runs}\nspesavicina_ingestion_errors_total{retailer="${RETAILER}"} ${status.errors}\nspesavicina_ingestion_last_offer_count{retailer="${RETAILER}"} ${status.lastOfferCount}\n`);
    }
    if (request.method === "POST" && request.url === "/run") {
      requireService(request);
      return json(response, 200, await runIngestion());
    }
    if (request.method === "POST" && request.url === "/analyze") {
      requireService(request);
      const input = await body(request);
      if (!input.store?.id) throw Object.assign(new Error("store is required"), { status: 422 });
      return json(response, 200, await runIngestion(input.store));
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    status.errors += 1;
    console.error(JSON.stringify({ level: "error", service: SERVICE, retailer: RETAILER, message: error.message, causes: errorContext(error) }));
    return json(response, error.status ?? 500, { error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", service: SERVICE, message: "ready", port: PORT })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
