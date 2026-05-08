import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { authority, audience, configured, authDisabled, devUser } from "./oidc.ts";

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

// Cheap RFC-5322-ish sanity check. The X-User-Email hint is informational
// only (the bearer is what authenticates), but we still don't want to
// stash arbitrary garbage into `last_edited_by`.
const EMAIL_HINT_RE = /^[^\s@]{1,128}@[^\s@]{1,128}$/;

function emailFromHint(req: Request): string | null {
  const v = req.headers.get("x-user-email")?.trim();
  return v && EMAIL_HINT_RE.test(v) ? v : null;
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
  // DEV_USER. The boot guard in server.ts refuses to start with
  // DISABLE_AUTH=true outside NODE_ENV=development, so this can't ship
  // accidentally.
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
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      algorithms: ALGORITHMS,
    });
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    if (!ISSUERS.includes(iss)) {
      return { ok: false, status: 403, error: `issuer ${iss} not allowed` };
    }
    // Email derivation: standard claim -> namespaced claim -> SPA hint
    // (X-User-Email, since partner.entur.org access tokens don't carry
    // email) -> `sub` so we always have *something* identifying the
    // editor.
    const email =
      emailFromClaims(payload) ??
      emailFromHint(req) ??
      (typeof payload.sub === "string" ? payload.sub : null);
    return { ok: true, email, claims: payload };
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
