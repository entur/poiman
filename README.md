# poiman

POI editor for Entur's event NeTEx feed. Edits are served immediately
as NeTEx at `GET /api/export/netex`, which the geocoder import reads.

## Stack

- Bun + TypeScript for server, bundler and tests. Use `bun install`;
  `npm install` is blocked.
- Postgres on Cloud SQL, provisioned in `terraform/`.
- Preact + signals + MapLibre GL in the browser.
- Auth0 login (Authorization Code + PKCE) via Entur's partner login,
  verified in-app.

## Local development

```sh
docker compose up -d    # postgres + poiman with hot reload
bun install             # editor tooling on the host
open http://localhost:8080
```

Compose sets `DISABLE_AUTH=true`: no login, and every edit is stamped
`dev@local` (override with `DEV_USER`). To use real Auth0 locally, copy
`.env.example` to `.env` and fill it in.

## Tests

```sh
bun test            # unit tests, plus integration tests if :8080 is up
bun run lint
bun run typecheck
```

## Endpoints

| Access        | Endpoint                                     |
| ------------- | -------------------------------------------- |
| Public        | `GET /`, `/config.json`, `/liveness`, `/readiness`, `/metrics` |
| Public        | `GET /api/export/netex` - live NeTEx XML     |
| Logged in     | `GET /api/me`, `/api/pois`, `/api/pois/:id`, `/api/geocode?q=` |
| Editors       | `POST /api/pois`, `PUT\|DELETE /api/pois/:id` |
| Editors       | `POST /api/import/netex?mode=merge\|replace` |

Authenticated requests send `Authorization: Bearer <access token>` and
`X-Id-Token: <id token>`. The email in the verified ID token is checked
against `EDITORS`.

## Configuration

| Variable                          | Source                    |
| --------------------------------- | ------------------------- |
| `OIDC_AUTHORITY`, `OIDC_AUDIENCE` | `helm/poiman/env/*.yaml`  |
| `OIDC_CLIENT_ID`                  | Secret Manager            |
| `EDITORS`                         | Secret Manager            |
| `PG*`                             | Secret Manager, via terraform |

Migrations in `src/server/migrations/` run at startup. Infrastructure:
`terraform -chdir=terraform apply -var-file=env/<env>.tfvars`.

## Editors

Anyone with an Entur login can view POIs. Only emails in the `EDITORS`
secret can edit. To change who can edit in `<env>` (dev, tst, prd):

```sh
gcloud secrets versions access latest --secret=EDITORS --project=ent-poiman-<env>
printf '%s' 'a@entur.org,b@entur.org' |
  gcloud secrets versions add EDITORS --project=ent-poiman-<env> --data-file=-
```

Pass the full list, not just the change. Wait an hour for the cluster to
sync the secret, then restart poiman:
`kubectl -n poiman rollout restart deployment/poiman`.

## License

[EUPL-1.2](LICENSE.md)
