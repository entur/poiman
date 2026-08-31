import { isPoiType, POI_TYPES } from "../../shared/poiTypes.ts";
import { emailFor } from "../auth.ts";
import { type Poi, type PoiInput, sql } from "../db.ts";

// bigserial comes back from Bun.sql as a string to preserve precision;
// our IDs fit comfortably in Number, and the wire format is plain JSON.
function normalize<T extends { id: unknown }>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r, id: Number(r.id) })) as T[];
}
function one<T extends { id: unknown }>(row: T): T {
  return { ...row, id: Number(row.id) };
}

// Column list for SELECT and RETURNING. Bun.sql treats nested `sql\`...\``
// fragments as raw substitution, so this stays parameter-free and safe to
// interpolate into the queries below.
const POI_COLS = sql`
  id, name, poi_type, longitude, latitude,
  valid_from, valid_to, deleted_at, created_at, updated_at,
  created_by, last_edited_by
`;

// Cap coordinate precision at 5 decimal places (~1.1m at Norwegian latitudes).
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, status);
}

function parseInput(raw: unknown): PoiInput | string {
  if (!raw || typeof raw !== "object") return "body must be an object";
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.trim() === "")
    return "name required";
  if (!isPoiType(r.poi_type))
    return `poi_type must be one of ${POI_TYPES.join(", ")}`;
  if (typeof r.longitude !== "number" || !Number.isFinite(r.longitude))
    return "longitude must be a number";
  if (typeof r.latitude !== "number" || !Number.isFinite(r.latitude))
    return "latitude must be a number";
  if (r.longitude < -180 || r.longitude > 180) return "longitude out of range";
  if (r.latitude < -90 || r.latitude > 90) return "latitude out of range";
  for (const k of ["valid_from", "valid_to"] as const) {
    if (typeof r[k] !== "string" && !(r[k] instanceof Date))
      return `${k} must be an ISO date string`;
    const d = new Date(r[k] as string | Date);
    if (Number.isNaN(d.getTime())) return `${k} is not a valid date`;
  }
  return {
    name: r.name.trim(),
    poi_type: r.poi_type,
    longitude: round5(r.longitude),
    latitude: round5(r.latitude),
    valid_from: new Date(r.valid_from as string | Date),
    valid_to: new Date(r.valid_to as string | Date),
  };
}

export async function listPois(): Promise<Response> {
  const rows = (await sql`
    select ${POI_COLS} from pois
    where deleted_at is null
    order by valid_from
  `) as Poi[];
  return json(normalize(rows));
}

export async function getPoi(id: number): Promise<Response> {
  const rows = (await sql`
    select ${POI_COLS} from pois
    where id = ${id} and deleted_at is null
  `) as Poi[];
  const poi = rows[0];
  if (!poi) return err(404, "not found");
  return json(one(poi));
}

export async function createPoi(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = parseInput(body);
  if (typeof parsed === "string") return err(400, parsed);
  const user = emailFor(req);
  const rows = (await sql`
    insert into pois (name, poi_type, longitude, latitude, valid_from, valid_to,
                      created_by, last_edited_by)
    values (${parsed.name}, ${parsed.poi_type}, ${parsed.longitude},
            ${parsed.latitude}, ${parsed.valid_from}, ${parsed.valid_to},
            ${user}, ${user})
    returning ${POI_COLS}
  `) as Poi[];
  const row = rows[0];
  if (!row) return err(500, "insert returned no rows");
  return json(one(row), 201);
}

export async function updatePoi(id: number, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = parseInput(body);
  if (typeof parsed === "string") return err(400, parsed);
  const user = emailFor(req);
  const rows = (await sql`
    update pois set
      name           = ${parsed.name},
      poi_type       = ${parsed.poi_type},
      longitude      = ${parsed.longitude},
      latitude       = ${parsed.latitude},
      valid_from     = ${parsed.valid_from},
      valid_to       = ${parsed.valid_to},
      last_edited_by = ${user},
      updated_at     = now()
    where id = ${id} and deleted_at is null
    returning ${POI_COLS}
  `) as Poi[];
  const row = rows[0];
  if (!row) return err(404, "not found");
  return json(one(row));
}

export async function deletePoi(id: number): Promise<Response> {
  const rows = (await sql`
    update pois set deleted_at = now()
    where id = ${id} and deleted_at is null
    returning id
  `) as { id: number }[];
  if (rows.length === 0) return err(404, "not found");
  return new Response(null, { status: 204 });
}
