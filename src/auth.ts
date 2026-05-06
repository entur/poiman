import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { authority, audience, configured } from "./oidc.ts";

const DEV = process.env.POIMAN_DEV === "1";
const DEV_USER = process.env.POIMAN_DEV_USER ?? "dev@local";

// Pin the algorithm. JOSE only enforces an allowlist when one is provided;
// without this the verifier relies on JWKS resolver behavior to reject
// unintended algs. RS256 is what Auth0 / partner.entur.org issues.
const ALGORITHMS = ["RS256"];

const ISSUERS = configured ? [authority, authority + "/"] : [];

const jwks = configured
  ? createRemoteJWKSet(new URL(`${authority}/.well-known/jwks.json`))
  : null;

export type AuthOk = {
  ok: true;
  email: string | null;
  claims: JWTPayload;
};
export type AuthFail = {
  ok: false;
  status: 401 | 403 | 500;
  error: string;
};
export type AuthResult = AuthOk | AuthFail;

function emailFromClaims(p: JWTPayload): string | null {
  if (typeof p.email === "string") return p.email;
  const ns = p["https://entur.io/email"];
  if (typeof ns === "string") return ns;
  return null;
}

// Verify-once cache: the server gate runs authenticate() and stashes the
// result here keyed by Request, so routes can read the email without
// re-running jwtVerify.
const cache = new WeakMap<Request, AuthResult>();

export async function authenticate(req: Request): Promise<AuthResult> {
  const cached = cache.get(req);
  if (cached) return cached;
  const result = await verify(req);
  cache.set(req, result);
  return result;
}

async function verify(req: Request): Promise<AuthResult> {
  if (DEV && !configured) {
    return { ok: true, email: DEV_USER, claims: { sub: DEV_USER } };
  }
  if (!jwks) {
    return { ok: false, status: 500, error: "auth not configured" };
  }
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const token = auth.slice("bearer ".length).trim();
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      algorithms: ALGORITHMS,
    });
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    if (!ISSUERS.includes(iss)) {
      return { ok: false, status: 403, error: `issuer ${iss} not allowed` };
    }
    return { ok: true, email: emailFromClaims(payload), claims: payload };
  } catch (err) {
    // Don't leak jose internals to the client; log server-side, return
    // a generic message. Caller maps to status code.
    console.warn(`jwt verify failed: ${(err as Error).message}`);
    return { ok: false, status: 401, error: "invalid token" };
  }
}

// Read the authenticated email after the server gate has run. Returns
// null only if a route is reached without going through the gate (which
// would be a server bug); routes that allow public access should not
// call this at all.
export function emailFor(req: Request): string | null {
  const r = cache.get(req);
  return r?.ok ? r.email : null;
}
