import { createServer } from "node:http";
import { extname, join, normalize as normalizePath } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closePool, migrate, pool } from "./db.js";
import { authenticatePassword, beginGoogleLogin, completeGoogleLogin, createSession, ensureBootstrapCredential, googleEnabled, registerWithPassword, revokeSession, sessionUser } from "./auth.js";
import { adminState, bootstrap, createWatch, deleteWatch, exportProfile, ingestOffers, readServiceNotification, reviewOffer, saveFeedback, searchProducts, seedData, setLocation, updateSettings, updateStore, updateWatch } from "./repository.js";

const SERVICE = "web-api";
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? fileURLToPath(new URL("../public", import.meta.url));
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "development-only";
const SESSION_COOKIE = "spesavicina_session";
const OAUTH_COOKIE = "spesavicina_oauth_state";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? new URL("/api/auth/google/callback", BASE_URL).href;
const INGESTOR_URLS = String(process.env.INGESTOR_URLS ?? "http://carrefour-ingestor/run,http://esselunga-ingestor/run,http://ekom-ingestor/run,http://coop-ingestor/run,http://lidl-ingestor/run,http://ins-ingestor/run,http://conad-ingestor/run,http://md-ingestor/run,http://pam-ingestor/run,http://borello-ingestor/run,http://crai-ingestor/run,http://mercato-ingestor/run").split(",").map((value) => value.trim()).filter(Boolean);
const startedAt = Date.now();
const metrics = { requests: 0, errors: 0, ingestions: 0 };

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png" };
const assetNames = ["index.html", "app.js", "styles.css", "manifest.webmanifest", "favicon.svg", "og.jpg", "sw.js", "logo-carrefour.svg", "logo-esselunga.svg"];
const staticFiles = new Map(assetNames.map((name) => [name, readFileSync(join(PUBLIC_DIR, name))]));
let ekomLogoCache = null;
const productImageCache = new Map();
const authAttempts = new Map();
const PRODUCT_IMAGE_HOSTS = new Set(["gdodig-car.youroperator.it", "images.services.esselunga.it", "app.ekomdiscount.it", "resources.volantinopiu.it", "www.coop.it", "www.lidl.it", "www.conad.it", "cdn.dimar.it", "strapi.crai.it", "crai.it", "www.mdspa.it", "www.insmercato.it", "borellosupermercati.it", "www.pampanorama.it", "static.mymercato.it"]);

function json(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { location, "cache-control": "no-store", ...headers });
  response.end();
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function cookie(request, name, value, { maxAge = 30 * 86400, path = "/" } = {}) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const secure = forwardedProtocol === "https" || request.socket.encrypted;
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clientAddress(request) {
  return String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "unknown").split(",")[0].trim();
}

function checkAuthRate(request, action, identity = "") {
  const now = Date.now();
  const key = `${action}:${clientAddress(request)}:${String(identity).trim().toLowerCase().slice(0, 254)}`;
  const current = authAttempts.get(key);
  const windowMs = 15 * 60_000;
  if (!current || now - current.startedAt > windowMs) { authAttempts.set(key, { count: 1, startedAt: now }); return; }
  current.count += 1;
  if (current.count > (action === "register" ? 5 : 10)) throw Object.assign(new Error("Too many attempts. Try again in a few minutes."), { status: 429 });
}

async function requireUser(request) {
  const user = await sessionUser(cookies(request)[SESSION_COOKIE]);
  if (!user) throw Object.assign(new Error("Sign in required."), { status: 401 });
  return user;
}

async function requireAdmin(request) {
  const user = await requireUser(request);
  if (!user.isAdmin) throw Object.assign(new Error("Administrator access required."), { status: 403 });
  return user;
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

function validateOrigin(request) {
  if (!["POST", "PATCH", "DELETE"].includes(request.method)) return;
  const origin = request.headers.origin;
  if (!origin) return;
  let originUrl;
  try { originUrl = new URL(origin); }
  catch { throw Object.assign(new Error("Origin not allowed"), { status: 403 }); }
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const requestHosts = new Set([request.headers.host, forwardedHost].filter(Boolean));
  const allowedOrigins = new Set([new URL(BASE_URL).origin, ...String(process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)]);
  if (!requestHosts.has(originUrl.host) && !allowedOrigins.has(originUrl.origin)) throw Object.assign(new Error("Origin not allowed"), { status: 403 });
}

function requireService(request) {
  if (request.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) throw Object.assign(new Error("Service authorization required"), { status: 401 });
}

async function triggerIngestors() {
  const results = await Promise.allSettled(INGESTOR_URLS.map(async (url) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${SERVICE_TOKEN}` }, signal: AbortSignal.timeout(120_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${url}: ${data.error ?? response.status}`);
    return data;
  }));
  return results.map((result, index) => result.status === "fulfilled" ? { url: INGESTOR_URLS[index], ok: true, ...result.value } : { url: INGESTOR_URLS[index], ok: false, error: result.reason.message });
}

async function api(request, response, url) {
  validateOrigin(request);
  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    const user = await sessionUser(cookies(request)[SESSION_COOKIE]);
    return json(response, 200, { authenticated: Boolean(user), user, googleEnabled: googleEnabled() });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    const input = await body(request); checkAuthRate(request, "register", input.email);
    const user = await registerWithPassword(input); const token = await createSession(user.id, request.headers["user-agent"]);
    return json(response, 201, { user }, { "set-cookie": cookie(request, SESSION_COOKIE, token) });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const input = await body(request); checkAuthRate(request, "login", input.email);
    const user = await authenticatePassword(input.email, input.password); const token = await createSession(user.id, request.headers["user-agent"]);
    return json(response, 200, { user }, { "set-cookie": cookie(request, SESSION_COOKIE, token) });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    await revokeSession(cookies(request)[SESSION_COOKIE]);
    return json(response, 200, { ok: true }, { "set-cookie": cookie(request, SESSION_COOKIE, "", { maxAge: 0 }) });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/google/start") {
    const login = await beginGoogleLogin(GOOGLE_REDIRECT_URI);
    return redirect(response, login.location, { "set-cookie": cookie(request, OAUTH_COOKIE, login.state, { maxAge: 600, path: "/api/auth/google" }) });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/google/callback") {
    if (url.searchParams.get("error")) return redirect(response, "/?auth=google_denied");
    const result = await completeGoogleLogin({ state: url.searchParams.get("state"), cookieState: cookies(request)[OAUTH_COOKIE], code: url.searchParams.get("code"), redirectUri: GOOGLE_REDIRECT_URI, userAgent: request.headers["user-agent"] });
    return redirect(response, "/", { "set-cookie": [cookie(request, SESSION_COOKIE, result.token), cookie(request, OAUTH_COOKIE, "", { maxAge: 0, path: "/api/auth/google" })] });
  }

  if (request.method === "POST" && url.pathname === "/internal/ingestions/offers") {
    requireService(request);
    const input = await body(request);
    if (!Array.isArray(input.offers)) return json(response, 422, { error: "offers must be an array" });
    metrics.ingestions += 1;
    return json(response, 202, await ingestOffers(input.offers, String(input.source ?? "unknown"), input.diagnostics ?? [], input.snapshot ?? {}));
  }

  const user = await requireUser(request);
  if (request.method === "GET" && url.pathname === "/api/bootstrap") return json(response, 200, await bootstrap(user.id));
  if (request.method === "GET" && url.pathname === "/api/products/search") return json(response, 200, { products: await searchProducts(String(url.searchParams.get("q") ?? "").slice(0, 120)) });

  if (request.method === "POST" && url.pathname === "/api/watch-items") {
    const input = await body(request);
    const minSaving = Number(input.minSaving ?? 1);
    if (!input.productId || !Number.isFinite(minSaving) || minSaving < 0) return json(response, 422, { error: "Select a catalogue product and enter a valid saving threshold." });
    return json(response, 201, { id: await createWatch(user.id, String(input.productId), minSaving) });
  }
  const watchMatch = url.pathname.match(/^\/api\/watch-items\/(\d+)$/);
  if (watchMatch && request.method === "PATCH") { await updateWatch(user.id, Number(watchMatch[1]), await body(request)); return json(response, 200, { ok: true }); }
  if (watchMatch && request.method === "DELETE") { await deleteWatch(user.id, Number(watchMatch[1])); return json(response, 200, { ok: true }); }

  const storeMatch = url.pathname.match(/^\/api\/stores\/([^/]+)$/);
  if (storeMatch && request.method === "PATCH") { const input = await body(request); return json(response, 200, { ok: true, ...await updateStore(user.id, decodeURIComponent(storeMatch[1]), input.selected) }); }
  if (request.method === "POST" && url.pathname === "/api/location") {
    const input = await body(request);
    const latitude = Number(input.latitude); const longitude = Number(input.longitude); const accuracy = input.accuracy == null ? null : Number(input.accuracy);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return json(response, 422, { error: "Invalid geographic coordinates." });
    return json(response, 202, await setLocation(user.id, latitude, longitude, Number.isFinite(accuracy) ? accuracy : null));
  }
  if (request.method === "PATCH" && url.pathname === "/api/settings") return json(response, 200, { ok: true, ...await updateSettings(user.id, await body(request)) });

  const feedbackMatch = url.pathname.match(/^\/api\/notifications\/(\d+)\/feedback$/);
  if (feedbackMatch && request.method === "POST") {
    const input = await body(request);
    if (!["useful", "not_useful", "bought"].includes(input.value)) return json(response, 422, { error: "Invalid feedback value." });
    await saveFeedback(user.id, Number(feedbackMatch[1]), input.value);
    return json(response, 200, { ok: true });
  }
  const serviceNotificationMatch = url.pathname.match(/^\/api\/service-notifications\/(\d+)\/read$/);
  if (serviceNotificationMatch && request.method === "POST") { await readServiceNotification(user.id, Number(serviceNotificationMatch[1])); return json(response, 200, { ok: true }); }

  if (request.method === "GET" && url.pathname === "/api/profile/export") return json(response, 200, await exportProfile(user.id), { "content-disposition": "attachment; filename=spesavicina-export.json" });
  if (request.method === "GET" && url.pathname === "/api/admin") { await requireAdmin(request); return json(response, 200, await adminState()); }
  if (request.method === "POST" && url.pathname === "/api/admin/ingest") { await requireAdmin(request); return json(response, 200, { results: await triggerIngestors() }); }
  const reviewMatch = url.pathname.match(/^\/api\/admin\/offers\/(\d+)$/);
  if (reviewMatch && request.method === "PATCH") {
    await requireAdmin(request);
    const input = await body(request);
    if (!["approved", "rejected"].includes(input.status)) return json(response, 422, { error: "Invalid review decision." });
    await reviewOffer(Number(reviewMatch[1]), input.status);
    return json(response, 200, { ok: true });
  }

  return json(response, 404, { error: "API route not found." });
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : normalizePath(pathname).replace(/^([/\\])+/, "");
  if (requested.includes("..")) return false;
  const data = staticFiles.get(requested);
  if (!data) return false;
  response.writeHead(200, {
    "content-type": mimeTypes[extname(requested)] ?? "application/octet-stream",
    "cache-control": requested === "index.html" ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https://www.ekomdiscount.it; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(data);
  return true;
}

async function serveEkomLogo(response) {
  if (!ekomLogoCache) {
    const upstream = await fetch("https://www.ekomdiscount.it/logo/logo.png", { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" } });
    if (!upstream.ok) throw Object.assign(new Error(`Ekom logo returned ${upstream.status}`), { status: 502 });
    ekomLogoCache = Buffer.from(await upstream.arrayBuffer());
  }
  response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
  response.end(ekomLogoCache);
}

async function serveProductImage(response, source) {
  let sourceUrl;
  try { sourceUrl = new URL(source); }
  catch { throw Object.assign(new Error("Invalid product image URL"), { status: 400 }); }
  if (sourceUrl.protocol !== "https:" || !PRODUCT_IMAGE_HOSTS.has(sourceUrl.hostname)) throw Object.assign(new Error("Product image host is not allowed"), { status: 403 });
  let cached = productImageCache.get(sourceUrl.href);
  if (!cached) {
    const upstream = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)", accept: "image/avif,image/webp,image/png,image/jpeg,image/*" } });
    if (!upstream.ok) throw Object.assign(new Error(`Product image returned ${upstream.status}`), { status: 502 });
    const finalUrl = new URL(upstream.url);
    if (!PRODUCT_IMAGE_HOSTS.has(finalUrl.hostname)) throw Object.assign(new Error("Product image redirect is not allowed"), { status: 403 });
    const contentType = String(upstream.headers.get("content-type") ?? "").split(";")[0];
    if (!contentType.startsWith("image/")) throw Object.assign(new Error("Product image source did not return an image"), { status: 502 });
    const data = Buffer.from(await upstream.arrayBuffer());
    if (data.length > 5_000_000) throw Object.assign(new Error("Product image is too large"), { status: 413 });
    cached = { contentType, data };
    if (productImageCache.size >= 300) productImageCache.delete(productImageCache.keys().next().value);
    productImageCache.set(sourceUrl.href, cached);
  }
  response.writeHead(200, { "content-type": cached.contentType, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
  response.end(cached.data);
}

await migrate();
await seedData();
await ensureBootstrapCredential();

const server = createServer(async (request, response) => {
  metrics.requests += 1;
  const url = new URL(request.url, BASE_URL);
  try {
    if (url.pathname === "/healthz") return json(response, 200, { status: "ok", service: SERVICE, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
    if (url.pathname === "/readyz") { await pool.query("SELECT 1"); return json(response, 200, { status: "ready", service: SERVICE }); }
    if (url.pathname === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return response.end(Object.entries(metrics).map(([name, value]) => `spesavicina_${name}_total{service="${SERVICE}"} ${value}`).join("\n") + "\n");
    }
    if (request.method === "GET" && url.pathname === "/logo-ekom.png") return await serveEkomLogo(response);
    if (request.method === "GET" && url.pathname === "/api/product-image") return await serveProductImage(response, url.searchParams.get("url") ?? "");
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) return await api(request, response, url);
    if (request.method === "GET" && serveStatic(response, url.pathname)) return;
    if (request.method === "GET") return serveStatic(response, "/");
    return json(response, 404, { error: "Not found." });
  } catch (error) {
    metrics.errors += 1;
    console.error(JSON.stringify({ level: "error", service: SERVICE, path: url.pathname, message: error.message, code: error.code }));
    return json(response, error.status ?? 500, { error: error.status ? error.message : "Something went wrong." });
  }
});

server.listen(PORT, HOST, () => console.log(JSON.stringify({ level: "info", service: SERVICE, message: "ready", url: BASE_URL, port: PORT })));

async function shutdown() { server.close(); await closePool(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
