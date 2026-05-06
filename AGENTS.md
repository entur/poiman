# poiman conventions

## Stack

- Bun >= 1.2 (uses `Bun.sql` for postgres). Do not introduce `pg`,
  `postgres.js`, or other postgres drivers.
- TypeScript strict mode + `noUncheckedIndexedAccess`. Do not weaken.
- Frontend: Preact + `@preact/signals`. No bundler config beyond the
  `bun build` invocation in `package.json`. No React, no Vite, no JSX
  pragma comments - `tsconfig.json` sets `jsxImportSource: "preact"`.
- Styling: a single `style.css` imported from `main.tsx`. No CSS-in-JS,
  no Tailwind.

## NeTEx output is load-bearing

`src/netex/serialize.ts` produces a NeTEx 1.5 PublicationDelivery that
is consumed by `nominatim-converter` (Rust, in this repo) and by the
photon import pipeline.

Rules:

- The serializer has a golden test against
  `geocoder-data/events_norway_poi.xml`. Keep that test passing for the
  first three POIs byte-for-byte. If the upstream consumer changes its
  schema expectations, update the golden file and the serializer in the
  same change.
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

poiman never sees an unauthenticated request in cluster - SSO/IAP is
configured at the ingress. Do not add app-side auth, login pages, or
session middleware. If a route needs to be public (e.g. for the photon
importer), add it to the ingress allowlist, not to the app.

## Tests

- `bun test` is the only test runner. No vitest, no jest.
- One `*.test.ts` file per module under test, co-located.
