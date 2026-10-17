import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { demoOffers, prepareOffer } from "./connectors.js";
import { matchWatchToOffer, normalize, offerSaving, productSearchScore, productSearchTokens, slug } from "./domain.js";

const CANONICAL_PRODUCTS = [
  { id: "santanna-acqua-naturale-6x1-5l", brand: "Sant'Anna", productName: "Acqua minerale", variant: "Naturale", packSize: "6 × 1,5 L", category: "Water", aliases: ["Santanna nat 6x1.5l", "Sant Anna naturale 6 x 1.5 l", "Acqua Sant'Anna naturale"] },
  { id: "lavazza-qualita-rossa-2x250g", brand: "Lavazza", productName: "Caffè", variant: "Qualità Rossa", packSize: "2 × 250 g", category: "Coffee", aliases: ["Lavazza rossa 2x250", "Caffe Lavazza qualita rossa 500g"] },
  { id: "barilla-spaghetti-n5-500g", brand: "Barilla", productName: "Pasta di semola", variant: "Spaghetti n.5", packSize: "500 g", category: "Pasta", aliases: ["Barilla spaghetti 5 mezzo chilo", "Spaghetti Barilla n5 500gr"] },
  { id: "brimi-yogurt-bianco-2x125g", brand: "Brimi", productName: "Yogurt intero", variant: "Bianco", packSize: "2 × 125 g", category: "Dairy", aliases: ["Brimi yoghurt bianco 2x125", "Yogurt Brimi naturale 250g"] },
];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', postcode TEXT NOT NULL DEFAULT '10153',
  address TEXT NOT NULL DEFAULT 'Corso Belgio 74, Torino', default_min_saving REAL NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 1, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY, retailer TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL,
  latitude REAL NOT NULL, longitude REAL NOT NULL, distance_km REAL NOT NULL, source_type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_stores (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, store_id TEXT NOT NULL REFERENCES stores(id),
  selected INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, store_id)
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, brand TEXT NOT NULL, product_name TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '',
  pack_size TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', search_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS product_aliases (
  id INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alias TEXT NOT NULL, normalized_alias TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS watch_items (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, brand TEXT NOT NULL,
  product_name TEXT NOT NULL, pack_size TEXT, min_saving REAL NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, product_id TEXT REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL, retailer TEXT NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id), product_name TEXT NOT NULL, brand TEXT NOT NULL,
  variant TEXT, pack_size TEXT, price REAL NOT NULL, list_price REAL, unit_price TEXT, condition_text TEXT,
  valid_from TEXT, valid_until TEXT, source_url TEXT NOT NULL, confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('approved','review','rejected','expired')), last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  product_id TEXT REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_id INTEGER NOT NULL REFERENCES watch_items(id) ON DELETE CASCADE, offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  saving REAL NOT NULL, match_reason TEXT NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT, UNIQUE(user_id, watch_id, offer_id)
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, notification_id)
);
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL, offers_found INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_offers_store_status ON offers(store_id, status);
CREATE INDEX IF NOT EXISTS idx_watch_user_active ON watch_items(user_id, active);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
`;

function rowToOffer(row) {
  return {
    id: row.id,
    productId: row.product_id,
    sourceId: row.source_id,
    slug: row.slug,
    retailer: row.retailer,
    storeId: row.store_id,
    productName: row.product_name,
    brand: row.brand,
    variant: row.variant,
    packSize: row.pack_size,
    price: row.price,
    listPrice: row.list_price,
    unitPrice: row.unit_price,
    condition: row.condition_text,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    sourceUrl: row.source_url,
    confidence: row.confidence,
    status: row.status,
    saving: offerSaving({ price: row.price, listPrice: row.list_price }),
  };
}

export function createStore(dbPath = process.env.DATABASE_PATH ?? "./data/spesavicina.sqlite") {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  ensureColumn("watch_items", "product_id", "TEXT REFERENCES products(id)");
  ensureColumn("offers", "product_id", "TEXT REFERENCES products(id)");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_watch_product ON watch_items(user_id, product_id); CREATE INDEX IF NOT EXISTS idx_offer_product ON offers(product_id, status);`);

  function productFromRow(row) {
    return {
      id: row.id, brand: row.brand, productName: row.product_name, variant: row.variant,
      packSize: row.pack_size, category: row.category,
      aliases: String(row.aliases ?? "").split("\u001f").filter(Boolean),
      currentBestPrice: row.current_best_price, activeOfferCount: Number(row.active_offer_count ?? 0),
      storeCount: Number(row.store_count ?? 0),
    };
  }

  function allProducts() {
    return db.prepare(`
      SELECT p.*, GROUP_CONCAT(DISTINCT pa.alias) AS aliases,
        MIN(CASE WHEN o.status='approved' THEN o.price END) AS current_best_price,
        COUNT(DISTINCT CASE WHEN o.status='approved' THEN o.id END) AS active_offer_count,
        COUNT(DISTINCT CASE WHEN o.status='approved' THEN o.store_id END) AS store_count
      FROM products p LEFT JOIN product_aliases pa ON pa.product_id=p.id
      LEFT JOIN offers o ON o.product_id=p.id AND (o.valid_until IS NULL OR date(o.valid_until) >= date('now'))
      GROUP BY p.id ORDER BY p.brand, p.product_name
    `).all().map((row) => productFromRow({ ...row, aliases: String(row.aliases ?? "").replaceAll(",", "\u001f") }));
  }

  function searchProducts(query, limit = 8) {
    return allProducts()
      .map((product) => ({ product, score: productSearchScore(query, product) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.product.activeOfferCount - left.product.activeOfferCount)
      .slice(0, limit)
      .map(({ product, score }) => ({ ...product, score }));
  }

  function insertCatalogProduct(product) {
    const searchText = productSearchTokens([product.brand, product.productName, product.variant, product.packSize, ...(product.aliases ?? [])].join(" ")).join(" ");
    db.prepare(`
      INSERT INTO products (id, brand, product_name, variant, pack_size, category, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET brand=excluded.brand, product_name=excluded.product_name, variant=excluded.variant,
        pack_size=excluded.pack_size, category=excluded.category, search_text=excluded.search_text, updated_at=CURRENT_TIMESTAMP
    `).run(product.id, product.brand, product.productName, product.variant ?? "", product.packSize ?? "", product.category ?? "", searchText);
    for (const alias of product.aliases ?? []) {
      const normalizedAlias = productSearchTokens(alias).join(" ");
      db.prepare(`INSERT INTO product_aliases (product_id, alias, normalized_alias) VALUES (?, ?, ?) ON CONFLICT(normalized_alias) DO UPDATE SET product_id=excluded.product_id, alias=excluded.alias`).run(product.id, alias, normalizedAlias);
    }
    return product.id;
  }

  function seedCatalog() {
    for (const product of CANONICAL_PRODUCTS) insertCatalogProduct(product);
  }

  function catalogProductForOffer(offer, allowCreate = true) {
    const candidates = searchProducts(`${offer.brand} ${offer.productName} ${offer.variant ?? ""} ${offer.packSize ?? ""}`, 4);
    const sameBrand = candidates.find((product) => productSearchScore(offer.brand, { ...product, productName: "", variant: "", packSize: "", aliases: [] }) > 0);
    if (sameBrand && sameBrand.score >= 35) return sameBrand.id;
    if (!allowCreate) return null;
    const id = slug(`${offer.brand}-${offer.productName}-${offer.variant ?? ""}-${offer.packSize ?? ""}`);
    return insertCatalogProduct({ id, brand: offer.brand, productName: offer.productName, variant: offer.variant ?? "", packSize: offer.packSize ?? "", category: "Other", aliases: [] });
  }

  function backfillCanonicalLinks() {
    for (const row of db.prepare(`SELECT * FROM offers WHERE product_id IS NULL`).all()) {
      const productId = catalogProductForOffer({ brand: row.brand, productName: row.product_name, variant: row.variant, packSize: row.pack_size });
      db.prepare(`UPDATE offers SET product_id=? WHERE id=?`).run(productId, row.id);
    }
    for (const row of db.prepare(`SELECT * FROM watch_items WHERE product_id IS NULL`).all()) {
      const candidate = searchProducts(`${row.brand} ${row.product_name} ${row.pack_size ?? ""}`, 1)[0];
      if (!candidate) continue;
      db.prepare(`UPDATE watch_items SET product_id=?, brand=?, product_name=?, pack_size=? WHERE id=?`).run(candidate.id, candidate.brand, [candidate.productName, candidate.variant].filter(Boolean).join(" "), candidate.packSize || null, row.id);
    }
  }

  function seed() {
    seedCatalog();
    db.prepare(`INSERT OR IGNORE INTO stores (id, retailer, name, address, latitude, longitude, distance_km, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "carrefour-corso-belgio", "Carrefour", "Carrefour Market · Corso Belgio", "Corso Belgio 173, Torino", 45.0797, 7.7082, 0.8, "pdf"
    );
    db.prepare(`INSERT OR IGNORE INTO stores (id, retailer, name, address, latitude, longitude, distance_km, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "esselunga-porta-nuova", "Esselunga", "Esselunga · Porta Nuova", "Corso Filippo Turati 27, Torino", 45.0544, 7.6761, 4.6, "html"
    );
    const userResult = db.prepare(`INSERT OR IGNORE INTO users (email, name, is_admin) VALUES (?, ?, 1)`).run("demo@spesavicina.local", "Nello");
    const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get("demo@spesavicina.local");
    for (const storeId of ["carrefour-corso-belgio", "esselunga-porta-nuova"]) {
      db.prepare(`INSERT OR IGNORE INTO user_stores (user_id, store_id, selected) VALUES (?, ?, 1)`).run(user.id, storeId);
    }
    const watchCount = db.prepare(`SELECT COUNT(*) AS count FROM watch_items WHERE user_id = ?`).get(user.id).count;
    if (!watchCount) {
      for (const [productId, minSaving] of [["santanna-acqua-naturale-6x1-5l", 1], ["lavazza-qualita-rossa-2x250g", 1], ["barilla-spaghetti-n5-500g", 0.3]]) {
        const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(productId);
        db.prepare(`INSERT INTO watch_items (user_id, product_id, brand, product_name, pack_size, min_saving) VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, product.id, product.brand, [product.product_name, product.variant].filter(Boolean).join(" "), product.pack_size || null, minSaving);
      }
    }
    ingest(demoOffers, "demo-seed");
    backfillCanonicalLinks();
    return Number(userResult.lastInsertRowid || user.id);
  }

  function ingest(rawOffers, source = "manual") {
    const run = db.prepare(`INSERT INTO ingestion_runs (source, status) VALUES (?, 'running')`).run(source);
    let reviewCount = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const raw of rawOffers) {
        const offer = prepareOffer(raw);
        const productId = catalogProductForOffer(offer, offer.status === "approved");
        if (offer.status === "review") reviewCount += 1;
        db.prepare(`
          INSERT INTO offers (source_id, slug, retailer, store_id, product_name, brand, variant, pack_size, price, list_price, unit_price, condition_text, valid_from, valid_until, source_url, confidence, status, product_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id) DO UPDATE SET product_name=excluded.product_name, brand=excluded.brand, variant=excluded.variant,
            pack_size=excluded.pack_size, price=excluded.price, list_price=excluded.list_price, unit_price=excluded.unit_price,
            condition_text=excluded.condition_text, valid_from=excluded.valid_from, valid_until=excluded.valid_until,
            source_url=excluded.source_url, confidence=excluded.confidence, status=excluded.status, product_id=excluded.product_id, last_seen_at=CURRENT_TIMESTAMP
        `).run(offer.sourceId, offer.slug, offer.retailer, offer.storeId, offer.productName, offer.brand, offer.variant ?? "", offer.packSize ?? "", offer.price, offer.listPrice ?? null, offer.unitPrice ?? "", offer.condition ?? "", offer.validFrom ?? null, offer.validUntil ?? null, offer.sourceUrl, offer.confidence, offer.status, productId);
      }
      db.exec("COMMIT");
      db.prepare(`UPDATE ingestion_runs SET status='success', offers_found=?, review_count=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`).run(rawOffers.length, reviewCount, run.lastInsertRowid);
    } catch (error) {
      db.exec("ROLLBACK");
      db.prepare(`UPDATE ingestion_runs SET status='failed', message=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`).run(error.message, run.lastInsertRowid);
      throw error;
    }
    matchAll();
    return { offersFound: rawOffers.length, reviewCount };
  }

  function matchAll() {
    const watches = db.prepare(`
      SELECT w.*, u.default_min_saving, us.store_id AS selected_store
      FROM watch_items w JOIN users u ON u.id=w.user_id
      JOIN user_stores us ON us.user_id=w.user_id AND us.selected=1
      WHERE w.active=1
    `).all();
    const offerQuery = db.prepare(`SELECT * FROM offers WHERE store_id=? AND status='approved' AND (valid_until IS NULL OR date(valid_until) >= date('now'))`);
    let created = 0;
    for (const watch of watches) {
      for (const row of offerQuery.all(watch.selected_store)) {
        const offer = rowToOffer(row);
        const match = matchWatchToOffer({ productId: watch.product_id, brand: watch.brand, productName: watch.product_name, packSize: watch.pack_size, minSaving: watch.min_saving }, offer);
        if (!match.matched) continue;
        const result = db.prepare(`INSERT OR IGNORE INTO notifications (user_id, watch_id, offer_id, saving, match_reason) VALUES (?, ?, ?, ?, ?)`).run(watch.user_id, watch.id, row.id, match.saving, match.reason);
        created += Number(result.changes);
      }
    }
    return created;
  }

  function createUser(email, name = "") {
    db.prepare(`INSERT OR IGNORE INTO users (email, name) VALUES (?, ?)`).run(email.toLowerCase(), name);
    const user = db.prepare(`SELECT * FROM users WHERE email=?`).get(email.toLowerCase());
    for (const store of db.prepare(`SELECT id FROM stores`).all()) {
      db.prepare(`INSERT OR IGNORE INTO user_stores (user_id, store_id, selected) VALUES (?, ?, 0)`).run(user.id, store.id);
    }
    return user;
  }

  function createWatch(userId, productId, minSaving) {
    const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(productId);
    if (!product) throw Object.assign(new Error("Select a product from the catalogue."), { status: 422 });
    const existing = db.prepare(`SELECT id FROM watch_items WHERE user_id=? AND product_id=?`).get(userId, productId);
    if (existing) throw Object.assign(new Error("You already track this product."), { status: 409 });
    const result = db.prepare(`INSERT INTO watch_items (user_id, product_id, brand, product_name, pack_size, min_saving) VALUES (?, ?, ?, ?, ?, ?)`).run(
      userId, product.id, product.brand, [product.product_name, product.variant].filter(Boolean).join(" "), product.pack_size || null, minSaving,
    );
    matchAll();
    return Number(result.lastInsertRowid);
  }

  function userBySession(token) {
    if (!token) return null;
    return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND datetime(s.expires_at) > datetime('now')`).get(token) ?? null;
  }

  function bootstrap(userId) {
    const user = db.prepare(`SELECT id, email, name, postcode, address, default_min_saving AS defaultMinSaving, email_enabled AS emailEnabled, is_admin AS isAdmin FROM users WHERE id=?`).get(userId);
    const stores = db.prepare(`SELECT s.*, COALESCE(us.selected,0) AS selected FROM stores s LEFT JOIN user_stores us ON us.store_id=s.id AND us.user_id=? WHERE s.enabled=1 ORDER BY s.distance_km`).all(userId).map((row) => ({
      id: row.id, retailer: row.retailer, name: row.name, address: row.address, latitude: row.latitude, longitude: row.longitude,
      distanceKm: row.distance_km, sourceType: row.source_type, selected: Boolean(row.selected),
    }));
    const watches = db.prepare(`SELECT id, product_id AS productId, brand, product_name AS productName, pack_size AS packSize, min_saving AS minSaving, active, created_at AS createdAt FROM watch_items WHERE user_id=? ORDER BY active DESC, created_at DESC`).all(userId).map((row) => ({ ...row, active: Boolean(row.active) }));
    const notifications = db.prepare(`
      SELECT n.id AS notification_id, n.saving AS matched_saving, n.match_reason, n.delivery_status, n.created_at AS notified_at,
        o.*, s.name AS store_name, f.value AS feedback
      FROM notifications n JOIN offers o ON o.id=n.offer_id JOIN stores s ON s.id=o.store_id
      LEFT JOIN feedback f ON f.notification_id=n.id AND f.user_id=n.user_id
      WHERE n.user_id=? ORDER BY n.created_at DESC
    `).all(userId).map((row) => ({ ...rowToOffer(row), notificationId: row.notification_id, saving: row.matched_saving, matchReason: row.match_reason, deliveryStatus: row.delivery_status, notifiedAt: row.notified_at, storeName: row.store_name, feedback: row.feedback }));
    const allOffers = db.prepare(`SELECT o.*, s.name AS store_name FROM offers o JOIN stores s ON s.id=o.store_id WHERE o.status='approved' ORDER BY (o.list_price-o.price) DESC`).all().map((row) => ({ ...rowToOffer(row), storeName: row.store_name }));
    return { user: { ...user, emailEnabled: Boolean(user.emailEnabled), isAdmin: Boolean(user.isAdmin) }, stores, watches, notifications, offers: allOffers, stats: { activeWatches: watches.filter((watch) => watch.active).length, matches: notifications.length, potentialSavings: notifications.reduce((sum, item) => sum + item.saving, 0) } };
  }

  function adminState() {
    return {
      reviews: db.prepare(`SELECT o.*, s.name AS store_name FROM offers o JOIN stores s ON s.id=o.store_id WHERE o.status='review' ORDER BY o.last_seen_at DESC`).all().map((row) => ({ ...rowToOffer(row), storeName: row.store_name })),
      runs: db.prepare(`SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT 12`).all(),
    };
  }

  function reviewOffer(offerId, status) {
    const offer = db.prepare(`SELECT * FROM offers WHERE id=?`).get(offerId);
    if (!offer) throw Object.assign(new Error("Offer not found."), { status: 404 });
    if (status === "approved") {
      const productId = catalogProductForOffer({ brand: offer.brand, productName: offer.product_name, variant: offer.variant, packSize: offer.pack_size }, true);
      db.prepare(`UPDATE offers SET status='approved', product_id=? WHERE id=?`).run(productId, offerId);
    } else {
      db.prepare(`UPDATE offers SET status='rejected' WHERE id=?`).run(offerId);
    }
    matchAll();
  }

  seed();
  return { db, ingest, matchAll, createUser, createWatch, searchProducts, userBySession, bootstrap, adminState, reviewOffer, normalize };
}
