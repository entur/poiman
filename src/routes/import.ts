import { sql } from "../db.ts";
import { userEmail } from "../auth.ts";
import { parseNetex } from "../netex/parse.ts";
import { POI_TYPES, isPoiType } from "../poiTypes.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MAX_IMPORT_CHARS = 10 * 1024 * 1024;

export async function importNetex(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "replace" ? "replace" : "merge";
  const xml = await req.text();
  if (xml.length > MAX_IMPORT_CHARS) {
    return json({ error: "payload too large" }, 413);
  }
  if (!xml.trim()) return json({ error: "empty body" }, 400);

  const parsed = parseNetex(xml);
  if (parsed.length === 0) {
    return json({ error: "no POIs found in XML" }, 400);
  }
  const bad = parsed.find((p) => !isPoiType(p.poi_type));
  if (bad) {
    return json(
      {
        error: `unknown poi_type "${bad.poi_type}"; allowed: ${POI_TYPES.join(", ")}`,
      },
      400,
    );
  }

  const user = userEmail(req);

  const result = await sql.begin(async (tx) => {
    let replaced = 0;
    if (mode === "replace") {
      const r = (await tx`
        update pois set deleted_at = now(), last_edited_by = ${user}
        where deleted_at is null
        returning id
      `) as { id: number }[];
      replaced = r.length;
    }
    let imported = 0;
    for (const r of parsed) {
      if (mode === "merge" && r.id !== undefined) {
        await tx`
          insert into pois (id, name, poi_type, longitude, latitude, valid_from, valid_to,
                            created_by, last_edited_by)
          values (${r.id}, ${r.name}, ${r.poi_type}, ${r.longitude}, ${r.latitude},
                  ${r.valid_from}::timestamptz, ${r.valid_to}::timestamptz,
                  ${user}, ${user})
          on conflict (id) do update set
            name           = excluded.name,
            poi_type       = excluded.poi_type,
            longitude      = excluded.longitude,
            latitude       = excluded.latitude,
            valid_from     = excluded.valid_from,
            valid_to       = excluded.valid_to,
            last_edited_by = ${user},
            deleted_at     = null,
            updated_at     = now()
        `;
      } else {
        await tx`
          insert into pois (name, poi_type, longitude, latitude, valid_from, valid_to,
                            created_by, last_edited_by)
          values (${r.name}, ${r.poi_type}, ${r.longitude}, ${r.latitude},
                  ${r.valid_from}::timestamptz, ${r.valid_to}::timestamptz,
                  ${user}, ${user})
        `;
      }
      imported++;
    }
    await tx`
      select setval(pg_get_serial_sequence('pois', 'id'),
                    coalesce((select max(id) from pois), 1))
    `;
    return { imported, replaced };
  });

  return json({ mode, ...result });
}
