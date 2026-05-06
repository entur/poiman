import { authority, clientId, audience, configured } from "../oidc.ts";

// Public bootstrap config served to the browser. The frontend fetches
// /config.json once at startup and feeds the oidcConfig into
// react-oidc-context's <AuthProvider>. Provider-agnostic shape
// (matches oidc-client-ts's UserManagerSettings).
export function config(): Response {
  const body = configured
    ? {
        oidcConfig: {
          authority,
          client_id: clientId,
          extraQueryParams: { audience },
          scope: "openid profile email",
        },
      }
    : { oidcConfig: null };
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
}
