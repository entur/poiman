# poiman

Internal POI editor for the Norwegian event NeTEx feed.

Replaces the manually-maintained `geocoder-data/events_norway_poi.xml`
with a Postgres-backed CRUD app. Edits land immediately in the live
NeTEx export at `GET /api/export/netex`, which `sources-prod.conf`
points at.

## Stack

- Bun + TypeScript (server, bundler, test runner). The repo uses
  Bun-only features (an `alias` map in `package.json`, `bun:test`); a
  `preinstall` script blocks `npm install`. Use `bun install`.
- Postgres on Cloud SQL (provisioned via Entur's `terraform-google-sql-db`
  module in `terraform/`; apply with
  `terraform -chdir=terraform apply -var-file=env/dev.tfvars`)
- MapLibre GL + Preact + signals (frontend), with `react-oidc-context`
  for Auth0 login (`react`/`react-dom` aliased to `preact/compat`).
- Auth: Auth0 SPA flow (Authorization Code + PKCE) via Entur's partner
  front-door. Backend verifies access tokens against Auth0 JWKS using
  `jose`. No SSO/IAP at the ingress - auth is in-app.

## Local dev

```sh
docker compose up -d                # postgres + poiman with hot reload
bun install                         # for editor / on-host scripts
bun run import-existing             # seed from ../geocoder-data/events_norway_poi.xml
open http://localhost:8080
```

`docker compose up` runs the prod-style container with `src/`, `dist/`,
`scripts/`, `tsconfig.json`, and `package.json` bind-mounted, plus
`bun --watch src/server.ts` for the server and `bun build --watch` for
the bundle. Edits on the host trigger reloads in the container.

The compose env sets `DISABLE_AUTH=true` and `NODE_ENV=development`. In
that mode auth is bypassed entirely: the backend stamps every edit as
`dev@local`, and the SPA skips `AuthProvider`. This holds regardless
of whether `OIDC_*` is set, so you can leave the prd values in place
and just flip `DISABLE_AUTH` on. Override the dev email with
`DEV_USER=alice@example.com`. The server logs a loud `WARNING` at
startup whenever `DISABLE_AUTH=true`.

The server refuses to start when `DISABLE_AUTH` is not `true` and any of
`OIDC_AUTHORITY` / `OIDC_CLIENT_ID` / `OIDC_AUDIENCE` is missing (catches
a half-configured prd deploy that would otherwise silently disable auth).

## Tests

```sh
bun test            # NeTEx serializer + parser (shared fixture in __fixtures__/)
bun run typecheck
```

There are no DB / integration tests yet; the routes are exercised manually.

## Endpoints

Public:

- `GET /` - SPA
- `GET /config.json` - `{oidcConfig}` for the SPA's Auth0 setup
- `GET /api/export/netex` - live NeTEx XML, consumed by the photon import
- `GET /liveness` `/readiness` `/metrics`

JWT-required (`Authorization: Bearer <token>`):

- `GET /api/pois` - list (excludes soft-deleted)
- `POST /api/pois`
- `GET|PUT|DELETE /api/pois/:id`
- `POST /api/import/netex?mode=merge|replace` - upload NeTEx XML

The token is validated against `${OIDC_AUTHORITY}/.well-known/jwks.json`
with `algorithms: [RS256]`, `audience: ${OIDC_AUDIENCE}`, and `iss`
matching `OIDC_AUTHORITY` (with or without trailing slash).

## Deployment

```sh
helm dependency update helm/poiman
helm template helm/poiman -f helm/poiman/env/values-kub-ent-dev.yaml
```

`common.postgres.enabled: true` provisions the CloudSQL Auth Proxy
sidecar that connects to the instance declared in `terraform/`. Schema
migrations run at app startup from `src/migrations/*.sql`.

The three OIDC env vars are wired via `common.configmap.data` and set
per-env in `helm/poiman/env/values-kub-ent-{dev,tst,prd}.yaml`. The
per-env `OIDC_CLIENT_ID` is provisioned by team sikkerhet and pasted in
once delivered (currently empty placeholder).

## Cutover plan

1. Land the CloudSQL instance:
   `terraform -chdir=terraform init && terraform -chdir=terraform apply -var-file=env/dev.tfvars`
   (repeat per env).
2. Order the per-env SPA Auth0 client from team sikkerhet. Required:
   - app: poiman
   - allowed callback / logout / web-origin URLs: bare origins
     (`http://localhost:8080`, `https://poiman.dev.entur.io`,
     `https://poiman.staging.entur.io`, `https://poiman.entur.io`)
   - grants: `authorization_code` + `refresh_token`, PKCE required
   - audience: existing `https://api.<env>.entur.io`
3. Paste the per-env `client_id` into the env values files.
4. Deploy poiman to dev. Run `bun run import-existing` against the dev
   DB. Verify `curl https://poiman.dev.entur.io/api/export/netex` diffs
   cleanly against `events_norway_poi.xml` (modulo `PublicationTimestamp`).
5. Promote to tst, repeat.
6. Promote to prd, seed once.
7. In `geocoder/photon/import/config/sources-prod.conf`, change
   `POI_URL` from the geocoder-data raw URL to
   `https://poiman.entur.io/api/export/netex`.
8. Freeze `geocoder-data/events_norway_poi.xml` for one release cycle as
   a fallback, then delete.
