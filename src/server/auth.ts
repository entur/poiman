import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from "jose";
import {
  authority,
  audience,
  clientId,
  configured,
  authDisabled,
  devUser,
} from "./oidc.ts";
import editorsList from "./editors.json" with { type: "json" };

// Identifies us upstream (Auth0 access logs, Entur API gateways). All
// outbound HTTP from poiman should set this.
const USER_AGENT = "entur-poiman";

// Pin the algorithm. JOSE only enforces an allowlist when one is provided;
// without this the verifier relies on JWKS resolver behavior to reject
// unintended algs. RS256 is what Auth0 / partner.entur.org issues.
const ALGORITHMS = ["RS256"];

const ISSUERS = configured ? [authority, authority + "/"] : [];

const jwks = configured
  ? createRemoteJWKSet(new URL(`${authority}/.well-known/jwks.json`), {
      [customFetch]: (url, opts) =>
        fetch(url, {
          ...opts,
          headers: { ...opts?.headers, "User-Agent": USER_AGENT },
        }),
    })
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

// Looks for an email-shaped claim. Auth0 puts `email` in the ID token by
// default; access tokens don't carry it unless a tenant rule copies it
// across. We also try any namespaced `*/email` claim (e.g. the
// `https://entur.io/email` style) before giving up.
function emailFromClaims(p: JWTPayload): string | null {
  if (typeof p.email === "string") return p.email;
  for (const [key, val] of Object.entries(p)) {
    if (key.endsWith("/email") && typeof val === "string") return val;
  }
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
  // DISABLE_AUTH=true disables auth entirely and stamps every request as
  // DEV_USER. A loud warning fires at boot; do not set in tst/prd.
  if (authDisabled) {
    return { ok: true, email: devUser, claims: { sub: devUser } };
  }
  if (!jwks) {
    return { ok: false, status: 500, error: "auth not configured" };
  }
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const token = auth.slice("bearer ".length).trim();
  let accessClaims: JWTPayload;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      algorithms: ALGORITHMS,
    });
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    if (!ISSUERS.includes(iss)) {
      return { ok: false, status: 403, error: `issuer ${iss} not allowed` };
    }
    accessClaims = payload;
  } catch (err) {
    // Don't leak jose internals; log server-side, return a generic message.
    console.warn(`access token verify failed: ${(err as Error).message}`);
    return { ok: false, status: 401, error: "invalid token" };
  }

  // Identity is the ID token, sent alongside the access token as
  // X-Id-Token. It's the single source of truth for who the editor is.
  // Returns null when the ID token is missing or doesn't pass all checks
  // - the editor gate then refuses, and last_edited_by falls back to sub
  // (display only).
  const email = await verifiedEmailFromIdToken(req, accessClaims.sub);
  return { ok: true, email, claims: accessClaims };
}

// Verify the ID token against the same JWKS but with audience = SPA
// client_id, and require sub to match the access token's sub so a leaked
// ID token can't be paired with someone else's access token. Returns the
// verified email or null. Misconfigurations log a warn so we don't end
// up silently in the sub-fallback path with editor checks quietly off.
async function verifiedEmailFromIdToken(
  req: Request,
  accessSub: unknown,
): Promise<string | null> {
  if (!jwks) return null;
  const idTokenStr = req.headers.get("x-id-token");
  if (!idTokenStr) return null;
  try {
    const { payload } = await jwtVerify(idTokenStr, jwks, {
      audience: clientId,
      algorithms: ALGORITHMS,
    });
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    if (!ISSUERS.includes(iss)) {
      console.warn(`id token issuer ${iss} not allowed`);
      return null;
    }
    if (typeof accessSub !== "string" || payload.sub !== accessSub) {
      console.warn("id token sub does not match access token sub");
      return null;
    }
    return emailFromClaims(payload);
  } catch (err) {
    console.warn(`id token verify failed: ${(err as Error).message}`);
    return null;
  }
}

// Read an identifier for the authenticated user, suitable for
// last_edited_by display: verified email when available, otherwise the
// access token's sub. Returns null only if a route is reached without
// going through the gate (which would be a server bug).
export function emailFor(req: Request): string | null {
  const r = cache.get(req);
  if (!r?.ok) return null;
  if (r.email) return r.email;
  return typeof r.claims.sub === "string" ? r.claims.sub : null;
}

// Allowlist of accounts permitted to mutate POIs. Every other authenticated
// user is read-only. Source of truth is editors.json; update by editing
// that file + deploy.
const EDITORS: ReadonlySet<string> = new Set(editorsList);

// Authorization gate for write endpoints. Strictly the verified email
// from the ID token - never the sub fallback, never an unsigned header.
// DISABLE_AUTH=true grants editor outright for local dev.
export function isEditor(req: Request): boolean {
  if (authDisabled) return true;
  const r = cache.get(req);
  if (!r?.ok || !r.email) return false;
  return EDITORS.has(r.email);
}
