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
import { config } from "./routes/config.ts";
import { authenticate } from "./auth.ts";
import { configured as oidcConfigured } from "./oidc.ts";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = import.meta.dir;
const WEB_DIST = join(ROOT, "..", "dist", "web");
const WEB_SRC = join(ROOT, "web");
const DEV = process.env.POIMAN_DEV === "1";

// Refuse to boot if the dev fallback is enabled outside an explicit
// development env. Without this guard, the dev short-circuit in auth.ts
// would silently stamp every edit as the dev fallback user. The
// docker-compose.yml dev workflow sets NODE_ENV=development; the prd
// Helm chart sets NODE_ENV=production via the Dockerfile.
if (DEV && process.env.NODE_ENV !== "development") {
  console.error(
    "FATAL: POIMAN_DEV=1 requires NODE_ENV=development. " +
      "Without an explicit development env, the dev fallback user could " +
      "ship to a real environment. Refusing to start.",
  );
  process.exit(1);
}

// Refuse to boot in non-dev mode if OIDC isn't configured. Otherwise the
// SPA loads (with /config.json returning oidcConfig:null) and the API
// runs unauthenticated. Loud failure is better than silent insecurity.
if (!DEV && !oidcConfigured) {
  console.error(
    "FATAL: OIDC_AUTHORITY/OIDC_CLIENT_ID/OIDC_AUDIENCE must all be set " +
      "in non-dev environments. Set POIMAN_DEV=1 only for local development.",
  );
  process.exit(1);
}

// Hard cap on the import body so a malicious or misbehaving client cannot
// stream gigabytes into req.text(). The full prod XML is ~30 KB; 10 MB is
// generous headroom.
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

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

// Public, no JWT required:
//   /liveness, /readiness, /metrics  - kubelet probes + prometheus
//   /config.json                     - bootstrap config the SPA needs to log in
//   GET /api/export/netex            - consumed by the photon importer
// Everything else under /api/* requires a valid Auth0 access token.

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/liveness") return liveness();
  if (pathname === "/readiness") return readiness();
  if (pathname === "/metrics") return metrics();
  if (pathname === "/config.json") return config();

  // Public read of the live NeTEx feed (replaces the static
  // events_norway_poi.xml in geocoder-data).
  if (pathname === "/api/export/netex" && method === "GET") {
    return exportNetex();
  }

  // Everything else under /api/* requires a valid token. authenticate()
  // memoises per-Request, so route handlers can call emailFor(req)
  // without re-running jwtVerify.
  if (pathname.startsWith("/api/")) {
    const auth = await authenticate(req);
    if (!auth.ok) return jsonError(auth.status, auth.error);
  }

  if (pathname === "/api/import/netex" && method === "POST") {
    const len = Number(req.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_IMPORT_BYTES) {
      return jsonError(413, `payload too large (max ${MAX_IMPORT_BYTES} bytes)`);
    }
    return importNetex(req);
  }

  if (pathname === "/api/pois") {
    if (method === "GET") return listPois();
    if (method === "POST") return createPoi(req);
    return jsonError(405, "method not allowed");
  }
  const m = POI_ID_RE.exec(pathname);
  if (m) {
    const id = Number(m[1]);
    if (method === "GET") return getPoi(id);
    if (method === "PUT") return updatePoi(id, req);
    if (method === "DELETE") return deletePoi(id);
    return jsonError(405, "method not allowed");
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
