# poiman

Internal POI editor for the Norwegian event NeTEx feed.

Replaces the manually-maintained `geocoder-data/events_norway_poi.xml`
with a Postgres-backed CRUD app. Edits land immediately in the live
NeTEx export at `GET /api/export/netex`, which `sources-prod.conf`
points at.

## Stack

- Bun + TypeScript (server, bundler, test runner)
- Postgres (in-cluster via the Entur common Helm chart)
- MapLibre GL + Preact + signals (frontend)
- Auth: Entur SSO at the ingress (no app-side auth)

## Local dev

```sh
docker compose up -d postgres
bun install
bun run import-existing                  # seed from events_norway_poi.xml
bun run dev                              # http://localhost:8080
```

In a second shell, rebuild the frontend on change:

```sh
bun build src/web/main.tsx --outdir dist/web --target browser --watch
```

## Tests

```sh
bun test
bun run typecheck
```

The serializer has a golden test that diffs against
`geocoder-data/events_norway_poi.xml` byte-for-byte.

## Endpoints

- `GET /` - SPA
- `GET /api/pois` - list (excludes soft-deleted)
- `POST /api/pois`
- `GET|PUT|DELETE /api/pois/:id`
- `GET /api/export/netex` - live NeTEx XML, used by the photon import
- `GET /liveness` `/readiness` `/metrics`

## Deployment

```sh
helm dependency update helm/poiman
helm lint helm/poiman
helm template helm/poiman -f helm/poiman/env/values-kub-ent-dev.yaml
```

`common.postgres.enabled: true` provisions the Postgres connection per
the Entur common chart. Inspect
`geocoder/helm/geocoder-proxy/charts/common-1.21.1.tgz` to confirm
whether this is an in-cluster pod or a Cloud SQL proxy sidecar before
the first prd rollout.

## Cutover plan

1. Deploy poiman to dev. Run `bun run import-existing` against the dev
   DB. Verify `curl https://poiman.dev.entur.io/api/export/netex` diffs
   cleanly against `events_norway_poi.xml` (modulo `PublicationTimestamp`).
2. Promote to tst, repeat.
3. Promote to prd, seed once.
4. In `geocoder/photon/import/config/sources-prod.conf`, change
   `POI_URL` from the geocoder-data raw URL to
   `https://poiman.entur.io/api/export/netex`.
5. Freeze `geocoder-data/events_norway_poi.xml` for one release cycle as
   a fallback, then delete.
