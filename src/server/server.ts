import { join } from "node:path";
import { migrate, waitForDb } from "./db.ts";
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
import { geocode } from "./routes/geocode.ts";
import { authenticate, isEditor } from "./auth.ts";
import { configured as oidcConfigured, authDisabled, devMode } from "./oidc.ts";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = import.meta.dir; // <repo>/src/server/
const CLIENT_DIST = join(ROOT, "..", "..", "dist", "client"); // <repo>/dist/client/
const CLIENT_SRC = join(ROOT, "..", "client"); // <repo>/src/client/

// Loud warning so anyone tailing logs sees the bypass. The setting is
// already explicit (DISABLE_AUTH=true is unambiguous in a values file);
// no need for a secondary boot guard that forces NODE_ENV=development
// in real environments.
if (authDisabled) {
  console.warn(
    "WARNING: DISABLE_AUTH=true. All requests are stamped as the dev " +
      "user; no JWT verification is performed. Do not set this in tst/prd.",
  );
}

// Refuse to boot when auth is required but OIDC isn't configured.
// Otherwise the SPA loads (with /config.json returning oidcConfig:null)
// and the API runs unauthenticated. Loud failure is better than silent
// insecurity.
if (!authDisabled && !oidcConfigured) {
  console.error(
    "FATAL: OIDC_AUTHORITY/OIDC_CLIENT_ID/OIDC_AUDIENCE must all be set " +
      "when DISABLE_AUTH is not true. Set DISABLE_AUTH=true only for " +
      "local development.",
  );
  process.exit(1);
}

// Hard cap on the import body so a malicious or misbehaving client cannot
// stream gigabytes into req.text(). The full prod XML is ~30 KB; 10 MB is
// generous headroom.
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

await waitForDb();
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

// Methods that mutate state; must carry a content-type that the browser
// won't send on a CORS-simple form POST. Without this check, while
// DISABLE_AUTH is on, a third-party page could submit a `<form
// enctype="text/plain">` with a JSON-shaped body and our `req.json()`
// would happily parse it. JSON / XML triggers preflight, which is what
// we want.
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_WRITE_TYPES = ["application/json", "application/xml"];

function contentTypeOk(req: Request): boolean {
  if (req.method === "DELETE") return true; // empty body is fine
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  return ALLOWED_WRITE_TYPES.some((t) => ct.startsWith(t));
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

  // Reject writes with a CORS-simple Content-Type. Doubles as CSRF
  // protection while DISABLE_AUTH is on (no Bearer header to gate on).
  if (
    pathname.startsWith("/api/") &&
    WRITE_METHODS.has(method) &&
    !contentTypeOk(req)
  ) {
    return jsonError(415, "Content-Type must be application/json or application/xml");
  }

  // Everything else under /api/* requires a valid token. authenticate()
  // memoises per-Request, so route handlers can call emailFor(req)
  // without re-running jwtVerify. Writes additionally require the user
  // to be on the editor allowlist; reads are open to any authenticated
  // user.
  if (pathname.startsWith("/api/")) {
    const auth = await authenticate(req);
    if (!auth.ok) return jsonError(auth.status, auth.error);
    if (WRITE_METHODS.has(method) && !isEditor(req)) {
      return jsonError(403, "editor permission required");
    }
  }

  if (pathname === "/api/geocode" && method === "GET") return geocode(req);
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
  // Bundled output wins. Source-tree statics (favicon, logos, etc.) are
  // co-located with index.html in src/client and don't go through the
  // bundler, so fall back there. URL.pathname is normalized per spec, so
  // `..` segments can't escape either root.
  for (const root of [CLIENT_DIST, CLIENT_SRC]) {
    const file = Bun.file(join(root, pathname));
    if (await file.exists()) {
      const headers: Record<string, string> = {};
      if (devMode) headers["Cache-Control"] = "no-cache, must-revalidate";
      return new Response(file, { headers });
    }
  }
  return new Response("not found", { status: 404 });
}

async function serveIndex(): Promise<Response> {
  const indexPath = join(CLIENT_SRC, "index.html");
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

console.log(
  `poiman listening on http://${server.hostname}:${server.port}` +
    `${authDisabled ? " (auth disabled)" : ""}${devMode && !authDisabled ? " (dev)" : ""}`,
);
