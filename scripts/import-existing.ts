// Seed the poiman DB from the legacy geocoder-data/events_norway_poi.xml file.
// Usage: bun scripts/import-existing.ts [path-to-xml]

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrate, sql } from "../src/server/db.ts";
import { parseNetex } from "../src/shared/netex/parse.ts";

const path =
  process.argv[2] ??
  join(import.meta.dir, "..", "..", "geocoder-data", "events_norway_poi.xml");

const xml = await readFile(path, "utf8");
const rows = parseNetex(xml);
console.log(`parsed ${rows.length} POIs from ${path}`);

await migrate(join(import.meta.dir, "..", "src", "server", "migrations"));

await sql.begin(async (tx) => {
  for (const r of rows) {
    if (r.id !== undefined) {
      await tx`
        insert into pois (id, name, poi_type, longitude, latitude, valid_from, valid_to)
        values (${r.id}, ${r.name}, ${r.poi_type}, ${r.longitude}, ${r.latitude},
                ${r.valid_from}::timestamptz, ${r.valid_to}::timestamptz)
        on conflict (id) do update set
          name       = excluded.name,
          poi_type   = excluded.poi_type,
          longitude  = excluded.longitude,
          latitude   = excluded.latitude,
          valid_from = excluded.valid_from,
          valid_to   = excluded.valid_to,
          deleted_at = null,
          updated_at = now()
      `;
    } else {
      await tx`
        insert into pois (name, poi_type, longitude, latitude, valid_from, valid_to)
        values (${r.name}, ${r.poi_type}, ${r.longitude}, ${r.latitude},
                ${r.valid_from}::timestamptz, ${r.valid_to}::timestamptz)
      `;
    }
  }
  await tx`
    select setval(pg_get_serial_sequence('pois', 'id'),
                  coalesce((select max(id) from pois), 1))
  `;
});

console.log(`imported ${rows.length} POIs`);
process.exit(0);
