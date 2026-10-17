import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/db.js";

test("seeded demo creates exact-match alerts without duplicates", () => {
  const store = createStore(":memory:");
  const user = store.db.prepare(`SELECT id FROM users WHERE email='demo@spesavicina.local'`).get();
  const first = store.bootstrap(user.id);
  assert.equal(first.stores.filter((item) => item.selected).length, 2);
  assert.ok(first.notifications.some((item) => item.brand === "Sant'Anna" && item.saving === 1.5));
  const before = first.notifications.length;
  store.matchAll();
  assert.equal(store.bootstrap(user.id).notifications.length, before);
  store.db.close();
});

test("different user spellings resolve to one canonical catalogue product", () => {
  const store = createStore(":memory:");
  const variants = ["Sant'Anna Naturale 6x1.5", "Sant Anna nat 6 x 1,5 l", "santana nat 6x1.5l"];
  for (const query of variants) assert.equal(store.searchProducts(query, 1)[0].id, "santanna-acqua-naturale-6x1-5l");
  store.db.close();
});

test("watch creation stores catalogue-owned names and rejects aliases as duplicates", () => {
  const store = createStore(":memory:");
  const user = store.createUser("catalogue@example.test", "Catalogue tester");
  const watchId = store.createWatch(user.id, "brimi-yogurt-bianco-2x125g", 0.5);
  const watch = store.db.prepare(`SELECT * FROM watch_items WHERE id=?`).get(watchId);
  assert.equal(watch.brand, "Brimi");
  assert.equal(watch.product_name, "Yogurt intero Bianco");
  assert.equal(watch.pack_size, "2 × 125 g");
  assert.throws(() => store.createWatch(user.id, "brimi-yogurt-bianco-2x125g", 1), (error) => error.status === 409);
  store.db.close();
});

test("uncertain extraction cannot create a catalogue product until approved", () => {
  const store = createStore(":memory:");
  const before = store.searchProducts("").length;
  store.ingest([{ retailer: "Carrefour", storeId: "carrefour-corso-belgio", productName: "Biscotti Croccanti", brand: "NuovaMarca", variant: "Cacao", packSize: "300 g", price: 1.99, listPrice: 2.99, sourceUrl: "https://example.test/flyer.pdf", confidence: 0.6, status: "review" }], "review-test");
  assert.equal(store.searchProducts("").length, before);
  const review = store.db.prepare(`SELECT id, product_id FROM offers WHERE brand='NuovaMarca'`).get();
  assert.equal(review.product_id, null);
  store.reviewOffer(review.id, "approved");
  assert.equal(store.searchProducts("").length, before + 1);
  store.db.close();
});

test("different users cannot read or mutate each other's watchlists", () => {
  const store = createStore(":memory:");
  const first = store.createUser("first@example.test", "First tester");
  const second = store.createUser("second@example.test", "Second tester");
  const firstWatch = store.createWatch(first.id, "brimi-yogurt-bianco-2x125g", 0.5);
  store.createWatch(second.id, "santanna-acqua-naturale-6x1-5l", 0.5);

  assert.deepEqual(store.bootstrap(first.id).watches.map((item) => item.id), [firstWatch]);
  assert.equal(store.bootstrap(second.id).watches.some((item) => item.id === firstWatch), false);

  store.db.prepare(`DELETE FROM watch_items WHERE id=? AND user_id=?`).run(firstWatch, second.id);
  assert.equal(store.bootstrap(first.id).watches.some((item) => item.id === firstWatch), true);
  store.db.close();
});
