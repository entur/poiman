# poiman conventions

## Stack

- Bun >= 1.2 (uses `Bun.sql` for postgres). Do not introduce `pg`,
  `postgres.js`, or other postgres drivers.
- TypeScript strict mode + `noUncheckedIndexedAccess`. Do not weaken.
- Frontend: Preact + `@preact/signals`. No bundler config beyond the
  `bun build` invocation in `package.json`. No React, no Vite, no JSX
  pragma comments - `tsconfig.json` sets `jsxImportSource: "preact"`.
  `react-oidc-context` is the one exception that needs a "react" import:
  the `alias` map in `package.json` and `paths` in `tsconfig.json`
  redirect `react`/`react-dom` to `preact/compat`. Don't add other libs
  that need real React.
- Styling: a single `style.css` imported from `main.tsx`. No CSS-in-JS,
  no Tailwind.

## NeTEx output is load-bearing

`src/netex/serialize.ts` produces a NeTEx 1.5 PublicationDelivery that
is consumed by `nominatim-converter` (Rust, in this repo) and by the
photon import pipeline.

Rules:

- The serializer has a byte-for-byte golden test against
  `src/netex/__fixtures__/three_pois.xml`. The fixture is shared with the
  parser test. If the upstream consumer changes its schema expectations,
  update the fixture and the serializer in the same change.
- All datetimes in the XML are wall-clock Europe/Oslo, no offset, no
  millis (e.g. `2026-03-01T00:00:00`). `formatOsloIso` is the only place
  that should format them.
- Coordinate precision: pass `Number.toString()` through unmodified. Do
  not pad with zeros, do not round.
- All POIs are exported, regardless of `valid_from`/`valid_to`. The
  consumer (`nominatim-converter`) filters by validity itself, including
  a 24h ToDate grace; do not pre-filter on the server side.

## Database

- One migrations directory: `src/migrations/`. Files are applied in
  filename order. New migrations go in new files; never edit applied
  migrations.
- Soft-delete via `deleted_at`. The export, list, and single-fetch
  routes filter out soft-deleted rows.

## Auth

poiman uses Auth0 SPA login (Authorization Code + PKCE) via Entur's
partner front-door (`https://partner.<env>.entur.org`). The SPA gets an
access token; the backend verifies it against Auth0's JWKS using `jose`
in `src/auth.ts`.

- Frontend: `react-oidc-context`'s `<AuthProvider>` wraps the App in
  `src/web/main.tsx`. `redirect_uri` is `window.location.origin` (no
  `/callback` path). Per-env SPA `client_id` is provisioned by team
  sikkerhet and injected via the `OIDC_CLIENT_ID` env var.
- Backend: `authenticate(req)` is called once in `src/server.ts` for
  every `/api/*` path except `GET /api/export/netex` (consumed by the
  photon importer). Result is memoised per `Request` via a `WeakMap`;
  routes call `emailFor(req)` to read the email without re-verifying.
- Public routes: `/liveness`, `/readiness`, `/metrics`, `/config.json`,
  and `GET /api/export/netex`. Adding a new public path requires touching
  the gate in `server.ts` deliberately.
- Local dev: `DISABLE_AUTH=true` bypasses auth entirely; the backend
  stamps `dev@local` (or `DEV_USER` if set) and the SPA skips
  `AuthProvider`. The server logs a loud `WARNING` at startup. When
  `DISABLE_AUTH` is not `true`, the three `OIDC_*` vars must all be set
  or boot fails.
- Token expiry: stale-token 401s trigger `signinRedirect()` (see
  `onUnauthorized` in `src/web/api.ts`), so the user is re-authenticated
  rather than left on a stuck error banner.

## Tests

- `bun test` is the only test runner. No vitest, no jest.
- One `*.test.ts` file per module under test, co-located.
