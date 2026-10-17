import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize as normalizePath } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "./db.js";
import { fetchLiveOffers } from "./connectors.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? fileURLToPath(new URL("../public", import.meta.url));
const store = createStore();
const startedAt = Date.now();
const metrics = { requests: 0, errors: 0, ingestions: 0, emails: 0 };

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};
const staticFiles = new Map(
  ["index.html", "app.js", "styles.css", "manifest.webmanifest", "favicon.svg", "og.jpg", "sw.js"]
    .map((name) => [name, readFileSync(join(PUBLIC_DIR, name))]),
);

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { location, ...headers });
  response.end();
}

function cookieValue(request, name) {
  const cookies = Object.fromEntries(String(request.headers.cookie ?? "").split(";").map((part) => part.trim().split(/=(.*)/s).slice(0, 2)));
  return cookies[name] ? decodeURIComponent(cookies[name]) : null;
}

function sessionCookie(token, request, maxAge = 60 * 60 * 24 * 30) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const secure = (forwardedProtocol === "https" || request.socket.encrypted) ? "; Secure" : "";
  return `spesavicina_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256_000) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

function requireUser(request) {
  const user = store.userBySession(cookieValue(request, "spesavicina_session"));
  if (!user) throw Object.assign(new Error("Sign in required"), { status: 401 });
  return user;
}

function requireAdmin(request) {
  const user = requireUser(request);
  if (!user.is_admin) throw Object.assign(new Error("Admin access required"), { status: 403 });
  return user;
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
  const allowedOrigins = new Set([
    new URL(BASE_URL).origin,
    ...String(process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ]);
  if (requestHosts.has(originUrl.host) || allowedOrigins.has(originUrl.origin)) return;
  throw Object.assign(new Error("Origin not allowed"), { status: 403 });
}

function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
  store.db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, expires);
  return token;
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM ?? "SpesaVicina <alerts@example.invalid>", to: [to], subject, html }),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  metrics.emails += 1;
  return true;
}

async function dispatchAlerts() {
  const pending = store.db.prepare(`
    SELECT n.id, n.saving, u.email, o.product_name, o.brand, o.price, o.valid_until, s.name AS store_name
    FROM notifications n JOIN users u ON u.id=n.user_id JOIN offers o ON o.id=n.offer_id JOIN stores s ON s.id=o.store_id
    WHERE n.delivery_status='queued' AND u.email_enabled=1 LIMIT 25
  `).all();
  for (const item of pending) {
    if (!process.env.RESEND_API_KEY) continue;
    await sendEmail(item.email, `${item.brand} is €${item.saving.toFixed(2)} cheaper nearby`, `<h1>An offer worth checking</h1><p><strong>${item.brand} ${item.product_name}</strong> is €${item.price.toFixed(2)} at ${item.store_name}.</p><p>You save €${item.saving.toFixed(2)}. Offer validity and stock should be checked with the retailer.</p><p><a href="${BASE_URL}">Open SpesaVicina</a></p>`);
    store.db.prepare(`UPDATE notifications SET delivery_status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?`).run(item.id);
  }
}

async function ingestLive(source = "scheduled") {
  metrics.ingestions += 1;
  const { offers, diagnostics } = await fetchLiveOffers();
  if (!offers.length) return { offersFound: 0, reviewCount: 0, diagnostics, message: "No live source URLs configured; demo data remains active." };
  return { ...store.ingest(offers, source), diagnostics };
}

async function api(request, response, url) {
  validateOrigin(request);
  if (request.method === "POST" && url.pathname === "/api/auth/demo") {
    const user = store.createUser("demo@spesavicina.local", "Nello");
    return json(response, 200, { ok: true }, { "set-cookie": sessionCookie(createSession(user.id), request) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/request") {
    const input = await body(request);
    const email = String(input.email ?? "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(response, 422, { error: "Enter a valid email address." });
    const user = store.createUser(email, String(input.name ?? "").trim());
    const token = randomBytes(32).toString("base64url");
    store.db.prepare(`INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, user.id, new Date(Date.now() + 15 * 60_000).toISOString());
    const magicLink = `${BASE_URL}/auth/verify?token=${token}`;
    const sent = await sendEmail(email, "Your SpesaVicina sign-in link", `<h1>Sign in to SpesaVicina</h1><p>This link expires in 15 minutes.</p><p><a href="${magicLink}">Sign in securely</a></p>`);
    return json(response, 200, { ok: true, sent, devMagicLink: sent ? undefined : magicLink });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/signout") {
    return json(response, 200, { ok: true }, { "set-cookie": sessionCookie("", request, 0) });
  }

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const user = requireUser(request);
    return json(response, 200, store.bootstrap(user.id));
  }

  if (request.method === "GET" && url.pathname === "/api/products/search") {
    requireUser(request);
    const query = String(url.searchParams.get("q") ?? "").slice(0, 120);
    return json(response, 200, { products: store.searchProducts(query) });
  }

  if (request.method === "POST" && url.pathname === "/api/watch-items") {
    const user = requireUser(request);
    const input = await body(request);
    const minSaving = Number(input.minSaving ?? user.default_min_saving ?? 1);
    if (!input.productId || !Number.isFinite(minSaving) || minSaving < 0) return json(response, 422, { error: "Select a catalogue product and enter a valid saving threshold." });
    const id = store.createWatch(user.id, String(input.productId), minSaving);
    return json(response, 201, { id });
  }

  const watchMatch = url.pathname.match(/^\/api\/watch-items\/(\d+)$/);
  if (watchMatch && request.method === "PATCH") {
    const user = requireUser(request); const input = await body(request);
    const existing = store.db.prepare(`SELECT * FROM watch_items WHERE id=? AND user_id=?`).get(Number(watchMatch[1]), user.id);
    if (!existing) return json(response, 404, { error: "Watch item not found." });
    store.db.prepare(`UPDATE watch_items SET min_saving=?, active=? WHERE id=? AND user_id=?`).run(
      Number(input.minSaving ?? existing.min_saving), input.active === undefined ? existing.active : Number(Boolean(input.active)), existing.id, user.id,
    );
    store.matchAll(); return json(response, 200, { ok: true });
  }
  if (watchMatch && request.method === "DELETE") {
    const user = requireUser(request);
    store.db.prepare(`DELETE FROM watch_items WHERE id=? AND user_id=?`).run(Number(watchMatch[1]), user.id);
    return json(response, 200, { ok: true });
  }

  const storeMatch = url.pathname.match(/^\/api\/stores\/([^/]+)$/);
  if (storeMatch && request.method === "PATCH") {
    const user = requireUser(request); const input = await body(request);
    store.db.prepare(`INSERT INTO user_stores (user_id, store_id, selected) VALUES (?, ?, ?) ON CONFLICT(user_id, store_id) DO UPDATE SET selected=excluded.selected`).run(user.id, storeMatch[1], Number(Boolean(input.selected)));
    store.matchAll(); return json(response, 200, { ok: true });
  }

  if (request.method === "PATCH" && url.pathname === "/api/settings") {
    const user = requireUser(request); const input = await body(request);
    const threshold = Number(input.defaultMinSaving ?? user.default_min_saving);
    if (!Number.isFinite(threshold) || threshold < 0) return json(response, 422, { error: "Saving threshold must be zero or more." });
    store.db.prepare(`UPDATE users SET name=?, address=?, postcode=?, default_min_saving=?, email_enabled=? WHERE id=?`).run(String(input.name ?? user.name).trim(), String(input.address ?? user.address).trim(), String(input.postcode ?? user.postcode).trim(), threshold, Number(input.emailEnabled ?? user.email_enabled), user.id);
    return json(response, 200, { ok: true });
  }

  const feedbackMatch = url.pathname.match(/^\/api\/notifications\/(\d+)\/feedback$/);
  if (feedbackMatch && request.method === "POST") {
    const user = requireUser(request); const input = await body(request);
    if (!["useful", "not_useful", "bought"].includes(input.value)) return json(response, 422, { error: "Invalid feedback value." });
    store.db.prepare(`INSERT INTO feedback (user_id, notification_id, value) VALUES (?, ?, ?) ON CONFLICT(user_id, notification_id) DO UPDATE SET value=excluded.value`).run(user.id, Number(feedbackMatch[1]), input.value);
    return json(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/account/export") {
    const user = requireUser(request);
    return json(response, 200, store.bootstrap(user.id), { "content-disposition": `attachment; filename="spesavicina-export-${user.id}.json"` });
  }
  if (request.method === "DELETE" && url.pathname === "/api/account") {
    const user = requireUser(request); store.db.prepare(`DELETE FROM users WHERE id=?`).run(user.id);
    return json(response, 200, { ok: true }, { "set-cookie": sessionCookie("", request, 0) });
  }

  if (request.method === "GET" && url.pathname === "/api/admin") { requireAdmin(request); return json(response, 200, store.adminState()); }
  if (request.method === "POST" && url.pathname === "/api/admin/ingest") { requireAdmin(request); return json(response, 200, await ingestLive("admin")); }
  const reviewMatch = url.pathname.match(/^\/api\/admin\/offers\/(\d+)$/);
  if (reviewMatch && request.method === "PATCH") {
    requireAdmin(request); const input = await body(request);
    if (!["approved", "rejected"].includes(input.status)) return json(response, 422, { error: "Invalid review decision." });
    store.reviewOffer(Number(reviewMatch[1]), input.status);
    return json(response, 200, { ok: true });
  }

  return json(response, 404, { error: "API route not found." });
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : normalizePath(pathname).replace(/^([/\\])+/, "");
  if (requested.includes("..")) return false;
  const data = staticFiles.get(requested);
  if (!data) return false;
  response.writeHead(200, { "content-type": mimeTypes[extname(requested)] ?? "application/octet-stream", "cache-control": requested === "index.html" ? "no-cache" : "public, max-age=3600", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  response.end(data);
  return true;
}

const server = createServer(async (request, response) => {
  metrics.requests += 1;
  const url = new URL(request.url, BASE_URL);
  try {
    if (url.pathname === "/healthz" || url.pathname === "/readyz") return json(response, 200, { status: "ok", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
    if (url.pathname === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return response.end(Object.entries(metrics).map(([name, value]) => `spesavicina_${name}_total ${value}`).join("\n") + "\n");
    }
    if (request.method === "GET" && url.pathname === "/auth/verify") {
      const token = url.searchParams.get("token");
      const auth = store.db.prepare(`SELECT * FROM auth_tokens WHERE token=? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`).get(token);
      if (!auth) return redirect(response, "/?auth=expired");
      store.db.prepare(`UPDATE auth_tokens SET used_at=CURRENT_TIMESTAMP WHERE token=?`).run(token);
      return redirect(response, "/", { "set-cookie": sessionCookie(createSession(auth.user_id), request) });
    }
    if (url.pathname.startsWith("/api/")) return await api(request, response, url);
    if (request.method === "GET" && serveStatic(response, url.pathname)) return;
    if (request.method === "GET") return serveStatic(response, "/");
    return json(response, 404, { error: "Not found." });
  } catch (error) {
    metrics.errors += 1;
    console.error(JSON.stringify({ level: "error", path: url.pathname, message: error.message }));
    return json(response, error.status ?? 500, { error: error.status ? error.message : "Something went wrong." });
  }
});

server.listen(PORT, HOST, () => console.log(JSON.stringify({ level: "info", message: "SpesaVicina ready", url: BASE_URL, port: PORT })));

setInterval(() => dispatchAlerts().catch((error) => console.error(JSON.stringify({ level: "error", job: "alerts", message: error.message }))), 60_000).unref();
setInterval(() => ingestLive("scheduled").catch((error) => console.error(JSON.stringify({ level: "error", job: "ingestion", message: error.message }))), 12 * 60 * 60_000).unref();

function shutdown() { server.close(() => { store.db.close(); process.exit(0); }); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
