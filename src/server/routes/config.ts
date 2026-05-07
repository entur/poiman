import {
  authority,
  clientId,
  audience,
  configured,
  authDisabled,
} from "../oidc.ts";

// Public bootstrap config served to the browser. The frontend fetches
// /config.json once at startup and feeds the oidcConfig into
// react-oidc-context's <AuthProvider>. Provider-agnostic shape
// (matches oidc-client-ts's UserManagerSettings).
//
// When DISABLE_AUTH=true we return null so the SPA skips AuthProvider
// entirely - matches the backend bypass and lets devs run with no Auth0
// at all.
export function config(): Response {
  const body =
    !authDisabled && configured
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
