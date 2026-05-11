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
bun install                         # for editor tooling on the host
open http://localhost:8080
```

`docker compose up` runs the prod-style container with `src/`, `dist/`,
`tsconfig.json`, and `package.json` bind-mounted, plus
`bun --watch src/server/server.ts` for the server and `bun build --watch`
for the bundle. Edits on the host trigger reloads in the container.

By default the compose env sets `DISABLE_AUTH=true` and
`NODE_ENV=development`. In that mode auth is bypassed entirely: the
backend stamps every edit as `dev@local` (override via `DEV_USER`), and
the SPA skips `AuthProvider`. The server logs a loud `WARNING` at
startup whenever `DISABLE_AUTH=true`.

To try the real Auth0 flow locally, drop a `.env` next to
`docker-compose.yml` (see `.env.example`) with `DISABLE_AUTH=false`
and the three `OIDC_*` vars; the dev SPA client already lists
`http://localhost:8080` as an allowed callback. The server refuses to
start with `DISABLE_AUTH=false` and any of `OIDC_AUTHORITY` /
`OIDC_CLIENT_ID` / `OIDC_AUDIENCE` unset.

## Tests

```sh
bun test            # NeTEx serializer + parser (shared fixture), bundle audit,
                    # and HTTP integration tests against the live compose server
bun run typecheck
```

The server integration suite (`src/server/server.test.ts`) is skipped
when nothing is reachable on port 8080, so a plain `bun test` works
without compose running. To exercise it, `docker compose up -d` first.

## Endpoints

Public:

- `GET /` - SPA
- `GET /config.json` - `{oidcConfig, editors, authDisabled}` for the SPA
- `GET /api/export/netex` - live NeTEx XML, consumed by the photon import
- `GET /liveness` `/readiness` `/metrics`

Authenticated reads (`Authorization: Bearer <access>` + `X-Id-Token: <id>`):

- `GET /api/pois` - list (excludes soft-deleted)
- `GET /api/pois/:id`
- `GET /api/geocode?q=...` - address autocomplete via Entur's geocoder

Editor-only writes (same headers, plus email must be in `src/server/editors.json`):

- `POST /api/pois`
- `PUT|DELETE /api/pois/:id`
- `POST /api/import/netex?mode=merge|replace` - upload NeTEx XML

The access token is validated against
`${OIDC_AUTHORITY}/.well-known/jwks.json` with `algorithms: [RS256]`,
`audience: ${OIDC_AUDIENCE}`, and `iss` matching `OIDC_AUTHORITY`. The
ID token is verified separately with `audience: ${OIDC_CLIENT_ID}` and
must share the access token's `sub`; its `email` claim is the verified
identity used for `last_edited_by` and the editor allowlist check.

## Deployment

```sh
helm dependency update helm/poiman
helm template helm/poiman -f helm/poiman/env/values-kub-ent-dev.yaml
```

`common.postgres.enabled: true` provisions the CloudSQL Auth Proxy
sidecar that connects to the instance declared in `terraform/`. Schema
migrations run at app startup from `src/server/migrations/*.sql`.

`OIDC_AUTHORITY` and `OIDC_AUDIENCE` are wired via
`common.configmap.data` per-env in
`helm/poiman/env/values-kub-ent-{dev,tst,prd}.yaml`. The per-env
`OIDC_CLIENT_ID` lives in Secret Manager (`OIDC_CLIENT_ID` in each GCP
project) and is mounted via the chart's `secrets:` block as an
`ExternalSecret`.
