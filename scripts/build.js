import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

rmSync("dist", { force: true, recursive: true });
mkdirSync("dist/public", { recursive: true });
cpSync("public", "dist/public", { recursive: true });

const entries = {
  api: "src/api.js",
  matcher: "src/workers/matcher.js",
  notifier: "src/workers/notifier.js",
  "store-analysis": "src/workers/store-analysis.js",
  ocr: "src/ocr/service.js",
  ingestor: "src/ingestors/service.js",
};

await Promise.all(Object.entries(entries).map(([name, entry]) => build({
  entryPoints: [entry],
  outfile: `dist/${name}.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  sourcemap: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
})));

writeFileSync("dist/ingestor.mjs.gz", gzipSync(readFileSync("dist/ingestor.mjs"), { level: 9 }));
writeFileSync("dist/ocr.mjs.gz", gzipSync(readFileSync("dist/ocr.mjs"), { level: 9 }));

console.log("Built API, workers, ingestor, OCR, and static assets in dist/");
