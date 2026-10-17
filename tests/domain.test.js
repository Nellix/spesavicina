import test from "node:test";
import assert from "node:assert/strict";
import { matchWatchToOffer, normalize, offerSaving, parseEuropeanPrice, productSearchScore, productSearchTokens } from "../server/domain.js";

const offer = { brand: "Sant'Anna", productName: "Acqua minerale naturale Sant'Anna", variant: "Naturale", packSize: "6 × 1,5 L", price: 2.49, listPrice: 3.99, confidence: 0.96 };

test("normalization is accent and punctuation insensitive", () => {
  assert.equal(normalize("Qualità Rossa — 250 g"), "qualita rossa 250 g");
});

test("exact brand and product match triggers from a single offer", () => {
  const result = matchWatchToOffer({ brand: "Sant'Anna", productName: "Acqua minerale naturale", minSaving: 1 }, offer);
  assert.equal(result.matched, true);
  assert.equal(result.saving, 1.5);
  assert.equal(result.reason, "exact_brand_and_product");
});

test("substitute brands never trigger", () => {
  const result = matchWatchToOffer({ brand: "San Benedetto", productName: "Acqua minerale naturale", minSaving: 0 }, offer);
  assert.equal(result.matched, false);
  assert.equal(result.reason, "brand_mismatch");
});

test("pack restriction and minimum saving are enforced", () => {
  assert.equal(matchWatchToOffer({ brand: "Sant'Anna", productName: "Acqua", packSize: "12 × 0,5 L", minSaving: 0 }, offer).reason, "pack_size_mismatch");
  assert.equal(matchWatchToOffer({ brand: "Sant'Anna", productName: "Acqua", minSaving: 2 }, offer).reason, "saving_below_threshold");
});

test("European flyer prices and savings are parsed", () => {
  assert.equal(parseEuropeanPrice("OFFERTA 2,49 €"), 2.49);
  assert.equal(offerSaving(offer), 1.5);
});

test("catalogue search normalizes apostrophes, abbreviations and pack notation", () => {
  const product = { brand: "Sant'Anna", productName: "Acqua minerale", variant: "Naturale", packSize: "6 × 1,5 L", aliases: ["Sant Anna naturale 6 x 1,5 l"] };
  assert.ok(productSearchScore("santanna nat 6x1.5", product) > 0);
  assert.ok(productSearchScore("Sant Anna naturale 6 x 1,5 l", product) > 0);
  assert.deepEqual(productSearchTokens("Sant'Anna Nat. 6×1,5 L"), ["santanna", "naturale", "6", "1", "5", "l"]);
});

test("catalogue search tolerates a small brand misspelling", () => {
  const product = { brand: "Sant'Anna", productName: "Acqua minerale", variant: "Naturale", packSize: "6 × 1,5 L", aliases: [] };
  assert.ok(productSearchScore("santana acqua naturale", product) > 0);
  assert.equal(productSearchScore("levissima acqua naturale", product), 0);
});

test("canonical product ids override ambiguous free-text matching", () => {
  const result = matchWatchToOffer({ productId: "product-a", brand: "Sant'Anna", productName: "Acqua", minSaving: 0 }, { ...offer, productId: "product-b" });
  assert.equal(result.matched, false);
  assert.equal(result.reason, "canonical_product_mismatch");
});
