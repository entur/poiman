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
