# poiman

Internal POI editor for the Norwegian event NeTEx feed.

Replaces the manually-maintained `geocoder-data/events_norway_poi.xml`
with a Postgres-backed CRUD app. Edits land immediately in the live
NeTEx export at `GET /api/export/netex`, which `sources-prod.conf`
points at.

## Stack

- Bun + TypeScript (server, bundler, test runner)
- Postgres on Cloud SQL (provisioned via Entur's `terraform-google-sql-db`
  module in `terraform/`; apply with
  `terraform -chdir=terraform apply -var-file=env/dev.tfvars`)
- MapLibre GL + Preact + signals (frontend)
- Auth: Entur SSO (Auth0 / oauth2-proxy) at the ingress, traffic type
  `internal`. The app reads the user from `X-Forwarded-Email`. No
  app-side auth.

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

In dev mode (`POIMAN_DEV=1`, set automatically by docker-compose),
unauthenticated requests are stamped with `dev@local` so the
"last edited by" feature is exercised. Override with
`POIMAN_DEV_USER=you@example.com` if you want a different name.
The server refuses to start with `POIMAN_DEV=1` and
`NODE_ENV=production` set.

## Tests

```sh
bun test            # serializer (golden against events_norway_poi.xml) + parser
bun run typecheck
```

There are no DB / integration tests yet; the routes are exercised manually.

## Endpoints

- `GET /` - SPA
- `GET /api/me` - current user (`{email}`)
- `GET /api/pois` - list (excludes soft-deleted)
- `POST /api/pois`
- `GET|PUT|DELETE /api/pois/:id`
- `POST /api/import/netex?mode=merge|replace` - upload NeTEx XML
- `GET /api/export/netex` - live NeTEx XML, used by the photon import
- `GET /liveness` `/readiness` `/metrics`

Writes (`POST` / `PUT` / `DELETE` / `PATCH`) require an `Origin` (or
`Referer`) header that matches the request host. CSRF; non-browser
callers must set `Origin` explicitly.

## Deployment

```sh
helm dependency update helm/poiman
helm template helm/poiman -f helm/poiman/env/values-kub-ent-dev.yaml
```

`common.postgres.enabled: true` provisions the CloudSQL Auth Proxy
sidecar that connects to the instance declared in the team-ror
terraform repo (see `terraform/poiman-postgres.tf`). Schema migrations
are applied by the app at startup from `src/migrations/*.sql`.

## Cutover plan

1. Land the CloudSQL instance:
   `terraform -chdir=terraform init && terraform -chdir=terraform apply -var-file=env/dev.tfvars`
   (repeat per env).
2. Deploy poiman to dev. Run `bun run import-existing` against the dev
   DB. Verify `curl https://poiman.dev.entur.io/api/export/netex` diffs
   cleanly against `events_norway_poi.xml` (modulo `PublicationTimestamp`).
3. Promote to tst, repeat.
4. Promote to prd, seed once.
5. In `geocoder/photon/import/config/sources-prod.conf`, change
   `POI_URL` from the geocoder-data raw URL to
   `https://poiman.entur.io/api/export/netex`.
6. Freeze `geocoder-data/events_norway_poi.xml` for one release cycle as
   a fallback, then delete.
