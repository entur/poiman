import { join } from "node:path";
import { migrate } from "./db.ts";
import { liveness, readiness } from "./routes/health.ts";
import {
  createPoi,
  deletePoi,
  getPoi,
  listPois,
  updatePoi,
} from "./routes/pois.ts";
import { exportNetex } from "./routes/export.ts";
import { importNetex } from "./routes/import.ts";
import { me } from "./routes/me.ts";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = import.meta.dir;
const WEB_DIST = join(ROOT, "..", "dist", "web");
const WEB_SRC = join(ROOT, "web");
const DEV = process.env.POIMAN_DEV === "1";

await migrate(join(ROOT, "migrations"));

const counters = {
  http_requests_total: new Map<string, number>(),
};

function bumpCounter(method: string, path: string, status: number): void {
  const key = `${method} ${path} ${status}`;
  counters.http_requests_total.set(
    key,
    (counters.http_requests_total.get(key) ?? 0) + 1,
  );
}

function metrics(): Response {
  const lines: string[] = [
    "# HELP poiman_http_requests_total Total HTTP requests by method, route, status",
    "# TYPE poiman_http_requests_total counter",
  ];
  for (const [key, n] of counters.http_requests_total) {
    const [method, path, status] = key.split(" ");
    lines.push(
      `poiman_http_requests_total{method="${method}",route="${path}",status="${status}"} ${n}`,
    );
  }
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
}

const POI_ID_RE = /^\/api\/pois\/(\d+)$/;

async function handle(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/liveness") return liveness();
  if (pathname === "/readiness") return readiness();
  if (pathname === "/metrics") return metrics();

  if (pathname === "/api/me" && method === "GET") return me(req);
  if (pathname === "/api/export/netex" && method === "GET") return exportNetex();
  if (pathname === "/api/import/netex" && method === "POST") return importNetex(req);

  if (pathname === "/api/pois") {
    if (method === "GET") return listPois();
    if (method === "POST") return createPoi(req);
    return new Response("method not allowed", { status: 405 });
  }
  const m = POI_ID_RE.exec(pathname);
  if (m) {
    const id = Number(m[1]);
    if (method === "GET") return getPoi(id);
    if (method === "PUT") return updatePoi(id, req);
    if (method === "DELETE") return deletePoi(id);
    return new Response("method not allowed", { status: 405 });
  }

  // Static SPA: serve index.html for /, bundled assets, and any unknown
  // path (so deep links work).
  if (method === "GET") return serveStatic(pathname);

  return new Response("not found", { status: 404 });
}

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === "/" || !pathname.includes(".")) {
    return serveIndex();
  }
  const candidate = join(WEB_DIST, pathname);
  const file = Bun.file(candidate);
  if (await file.exists()) {
    const headers: Record<string, string> = {};
    if (DEV) headers["Cache-Control"] = "no-cache, must-revalidate";
    return new Response(file, { headers });
  }
  return new Response("not found", { status: 404 });
}

async function serveIndex(): Promise<Response> {
  const indexPath = join(WEB_SRC, "index.html");
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    return new Response("frontend not built; run `bun run build`", {
      status: 500,
    });
  }
  return new Response(file, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let route = url.pathname;
    if (POI_ID_RE.test(route)) route = "/api/pois/:id";
    try {
      const res = await handle(req, url);
      bumpCounter(req.method, route, res.status);
      return res;
    } catch (err) {
      console.error(`error handling ${req.method} ${url.pathname}:`, err);
      bumpCounter(req.method, route, 500);
      return new Response("internal error", { status: 500 });
    }
  },
});

console.log(`poiman listening on http://${server.hostname}:${server.port}${DEV ? " (dev)" : ""}`);
