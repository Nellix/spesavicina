import { createServer } from "node:http";
import { closePool, pool } from "./db.js";

export function startHealthServer(serviceName, status) {
  const port = Number(process.env.PORT ?? 8080);
  const server = createServer(async (request, response) => {
    if (!["/healthz", "/readyz", "/metrics"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/readyz") {
      try { await pool.query("SELECT 1"); }
      catch { response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ status: "not_ready" })); return; }
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(`spesavicina_worker_processed_total{service="${serviceName}"} ${status.processed}\nspesavicina_worker_errors_total{service="${serviceName}"} ${status.errors}\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", service: serviceName, ...status }));
  });
  server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", service: serviceName, message: "worker ready", port })));
  const shutdown = async () => { server.close(); await closePool(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
