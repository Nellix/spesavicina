import test from "node:test";
import assert from "node:assert/strict";
import { isPdf, parseTesseractTsv } from "../server/ocr.js";

test("parseTesseractTsv reconstructs lines and ignores non-word rows", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t96.0\tSant'Anna",
    "5\t1\t1\t1\t1\t2\t11\t0\t10\t10\t84.0\tNaturale",
    "5\t1\t1\t1\t2\t1\t0\t12\t10\t10\t90.0\t2,49",
    "4\t1\t1\t1\t2\t0\t0\t12\t10\t10\t-1\t",
  ].join("\n");
  assert.deepEqual(parseTesseractTsv(tsv), { text: "Sant'Anna Naturale\n2,49", confidence: 0.9, words: 3 });
});

test("isPdf validates the file signature", () => {
  assert.equal(isPdf(Buffer.from("%PDF-1.7")), true);
  assert.equal(isPdf(Buffer.from("not a pdf")), false);
});
