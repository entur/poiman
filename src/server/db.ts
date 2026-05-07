import { SQL } from "bun";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Poi = {
  id: number;
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: Date;
  valid_to: Date;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  last_edited_by: string | null;
};

export type PoiInput = {
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: string | Date;
  valid_to: string | Date;
};

// Connection precedence:
//   1. PG{HOST,PORT,USER,PASSWORD,DATABASE} - injected by the Entur common
//      Helm chart from the CloudSQL secret (secret_key_prefix = "PG").
//   2. DATABASE_URL - used by docker-compose for local dev.
//   3. Hard-coded localhost default - last resort, only useful if you
//      forget to set anything.
function connectionUrl(): string {
  const e = process.env;
  if (e.PGHOST && e.PGUSER && e.PGPASSWORD) {
    const host = encodeURIComponent(e.PGHOST);
    const user = encodeURIComponent(e.PGUSER);
    const pass = encodeURIComponent(e.PGPASSWORD);
    const port = e.PGPORT ?? "5432";
    const db = e.PGDATABASE ?? "poiman";
    return `postgres://${user}:${pass}@${host}:${port}/${db}`;
  }
  return e.DATABASE_URL ?? "postgres://poiman:poiman@localhost:5432/poiman";
}

export const sql = new SQL(connectionUrl());

export async function migrate(migrationsDir: string): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (await sql`select filename from schema_migrations`).map(
      (r: { filename: string }) => r.filename,
    ),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (filename) values (${file})`;
    });
    console.log(`migrated: ${file}`);
  }
}

export async function ping(): Promise<void> {
  await sql`select 1`;
}
