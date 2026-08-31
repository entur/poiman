import { type NetexPoi, serializeNetex } from "../../shared/netex/serialize.ts";
import { sql } from "../db.ts";

export async function exportNetex(): Promise<Response> {
  const rows = (await sql`
    select id, name, poi_type, longitude, latitude, valid_from, valid_to
    from pois
    where deleted_at is null
    order by id
  `) as NetexPoi[];

  const xml = serializeNetex(rows);
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Disposition": 'inline; filename="events_norway_poi.xml"',
    },
  });
}
