import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, normalizeEmail, validatePassword, verifyPassword } from "../src/auth.js";

test("password credentials use salted scrypt digests", async () => {
  const first = await hashPassword("a-correct-horse-battery-staple");
  const second = await hashPassword("a-correct-horse-battery-staple");
  assert.match(first, /^\$scrypt\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a-correct-horse-battery-staple", first), true);
  assert.equal(await verifyPassword("the-wrong-password", first), false);
});

test("account identifiers and password limits are validated", () => {
  assert.equal(normalizeEmail("  Person@Example.COM "), "person@example.com");
  assert.throws(() => normalizeEmail("not-an-email"), (error) => error.status === 422);
  assert.throws(() => validatePassword("too-short"), (error) => error.status === 422);
  assert.equal(validatePassword("twelve-chars!"), "twelve-chars!");
});
