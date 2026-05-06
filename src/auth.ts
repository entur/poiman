// The Entur ingress (Auth0 / oauth2-proxy) forwards the authenticated
// user's identity in a header. Default to oauth2-proxy's convention;
// override via POIMAN_USER_HEADER if the proxy in front uses something else.
const HEADER = (process.env.POIMAN_USER_HEADER ?? "x-forwarded-email").toLowerCase();
const DEV = process.env.POIMAN_DEV === "1";
const DEV_USER = process.env.POIMAN_DEV_USER ?? "dev@local";

export function userEmail(req: Request): string | null {
  const v = req.headers.get(HEADER);
  const trimmed = v?.trim();
  if (trimmed) return trimmed;
  // No auth proxy in local dev. Fall back to a recognisable placeholder
  // so the "last edited by" feature is exercised.
  return DEV ? DEV_USER : null;
}
