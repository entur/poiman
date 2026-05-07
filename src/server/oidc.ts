// Shared OIDC config. Read once at module load, used by both the JWT
// verifier (auth.ts) and the SPA bootstrap endpoint (routes/config.ts).
//
// All three values are public:
//   OIDC_AUTHORITY  - issuer URL, e.g. https://partner.dev.entur.org
//   OIDC_CLIENT_ID  - SPA client id (per-env, ordered from team sikkerhet)
//   OIDC_AUDIENCE   - access-token audience, e.g. https://api.dev.entur.io

export const authority = (process.env.OIDC_AUTHORITY ?? "").replace(/\/$/, "");
export const clientId = process.env.OIDC_CLIENT_ID ?? "";
export const audience = process.env.OIDC_AUDIENCE ?? "";

export const configured =
  authority !== "" && clientId !== "" && audience !== "";

// DISABLE_AUTH=true bypasses Auth0 entirely. Lower-cased to tolerate
// whatever YAML-to-env coercion the Helm chart picks (`true`/`True`).
// The boot guard in server.ts refuses to start when this is set in a
// non-development environment.
export const authDisabled =
  (process.env.DISABLE_AUTH ?? "").toLowerCase() === "true";

export const devMode = process.env.NODE_ENV === "development";

// Bypass user shown for last_edited_by while DISABLE_AUTH is on.
// Using `||` rather than `??` so an empty-string env (which the chart
// ships as a default) still falls back to the literal default.
export const devUser = process.env.DEV_USER || "dev@local";
