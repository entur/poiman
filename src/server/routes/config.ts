import {
  authority,
  clientId,
  audience,
  configured,
  authDisabled,
} from "../oidc.ts";
import editorsList from "../editors.json" with { type: "json" };

// Public bootstrap config served to the browser. The frontend fetches
// /config.json once at startup, feeds oidcConfig into <AuthProvider>,
// and uses the editors list to decide whether to render the read-only
// UI variant. The list isn't secret - it's checked into git - so
// shipping it here saves a /api/me round-trip.
//
// When DISABLE_AUTH=true we return oidcConfig: null so the SPA skips
// AuthProvider entirely, and authDisabled: true so it treats the
// (anonymous) user as an editor to match the backend bypass.
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
    editors: editorsList.map((e) => e.toLowerCase()),
    authDisabled,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
}
