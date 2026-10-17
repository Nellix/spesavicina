import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseTesseractTsv, isPdf } from "../../server/ocr.js";

const PORT = Number(process.env.PORT ?? 8080);
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "development-only";
const CACHE_DIR = process.env.OCR_CACHE_DIR ?? "/data";
const WORK_DIR = process.env.OCR_WORK_DIR ?? "/tmp/spesavicina-ocr";
const MAX_PDF_BYTES = Number(process.env.OCR_MAX_PDF_BYTES ?? 60 * 1024 * 1024);
const MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? 48);
const DPI = Number(process.env.OCR_DPI ?? 200);
const OCR_LANGUAGES = process.env.OCR_LANGUAGES ?? "ita+eng";
const PAGE_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.OCR_PAGE_CONCURRENCY ?? 2)));
const PROCESS_TIMEOUT_MS = Number(process.env.OCR_PROCESS_TIMEOUT_MS ?? 240_000);
const status = { runs: 0, cacheHits: 0, errors: 0, busy: false, lastRunAt: null };

function json(response, code, value) {
  response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function authorized(request) {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${SERVICE_TOKEN}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function pdfBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PDF_BYTES) throw Object.assign(new Error("Flyer PDF is too large"), { status: 413 });
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!isPdf(buffer)) throw Object.assign(new Error("A PDF body is required"), { status: 415 });
  return buffer;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize <= 64 * 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`));
    });
  });
}

async function recognize(buffer) {
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const cachePath = join(CACHE_DIR, `${checksum}.json`);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    status.cacheHits += 1;
    return { ...cached, cached: true };
  } catch (error) {
    if (error.code !== "ENOENT") await rm(cachePath, { force: true });
  }

  const jobDir = join(WORK_DIR, randomUUID());
  await mkdir(jobDir, { recursive: true });
  try {
    const pdfPath = join(jobDir, "flyer.pdf");
    const imagePrefix = join(jobDir, "page");
    await writeFile(pdfPath, buffer);
    await run("pdftoppm", ["-jpeg", "-r", String(DPI), "-f", "1", "-l", String(MAX_PAGES), pdfPath, imagePrefix]);
    const images = (await readdir(jobDir)).filter((name) => /^page-\d+\.jpg$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!images.length) throw new Error("PDF renderer produced no pages");
    const pages = new Array(images.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, images.length) }, async () => {
      while (cursor < images.length) {
        const index = cursor++;
        const tsv = await run("tesseract", [join(jobDir, images[index]), "stdout", "-l", OCR_LANGUAGES, "--psm", "11", "tsv"]);
        pages[index] = parseTesseractTsv(tsv);
      }
    }));
    const wordCount = pages.reduce((sum, page) => sum + page.words, 0);
    const result = {
      checksum,
      text: pages.map((page) => page.text).filter(Boolean).join("\n\f\n"),
      confidence: wordCount ? Number((pages.reduce((sum, page) => sum + page.confidence * page.words, 0) / wordCount).toFixed(3)) : 0,
      words: wordCount,
      pages: pages.length,
      engine: "tesseract",
      languages: OCR_LANGUAGES,
      cached: false,
      createdAt: new Date().toISOString(),
    };
    await writeFile(cachePath, JSON.stringify(result));
    return result;
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(WORK_DIR, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz" || request.url === "/readyz") return json(response, 200, { status: "ok", service: "ocr-worker", ...status });
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return response.end(`spesavicina_ocr_runs_total ${status.runs}\nspesavicina_ocr_cache_hits_total ${status.cacheHits}\nspesavicina_ocr_errors_total ${status.errors}\nspesavicina_ocr_busy ${status.busy ? 1 : 0}\n`);
    }
    if (request.method !== "POST" || request.url !== "/ocr") return json(response, 404, { error: "Not found" });
    if (!authorized(request)) return json(response, 401, { error: "Service authorization required" });
    if (status.busy) return json(response, 429, { error: "OCR worker is busy", retryAfterSeconds: 30 });
    const buffer = await pdfBody(request);
    status.busy = true;
    try {
      const result = await recognize(buffer);
      status.runs += 1;
      status.lastRunAt = new Date().toISOString();
      return json(response, 200, result);
    } finally {
      status.busy = false;
    }
  } catch (error) {
    status.errors += 1;
    console.error(JSON.stringify({ level: "error", service: "ocr-worker", message: error.message }));
    return json(response, error.status ?? 500, { error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", service: "ocr-worker", message: "ready", port: PORT })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
