import {
  audience,
  authDisabled,
  authority,
  clientId,
  configured,
} from "../oidc.ts";

// Public bootstrap config served to the browser. The frontend fetches
// /config.json once at startup and feeds oidcConfig into <AuthProvider>.
//
// When DISABLE_AUTH=true we return oidcConfig: null so the SPA skips
// AuthProvider entirely.
export function config(): Response {
  const body = {
    oidcConfig:
      !authDisabled && configured
        ? {
            authority,
            client_id: clientId,
            extraQueryParams: { audience },
            scope: "openid profile email",
          }
        : null,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
}
