export type ParsedPoi = {
  id?: number;
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: string; // wall-clock followed by " Europe/Oslo" so postgres parses it as timestamptz
  valid_to: string;
};

const PLACE_RE =
  /<TopographicPlace\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/TopographicPlace>/g;
const ID_TAIL_RE = /:(\d+)$/;
const NAME_RE = /<Name[^>]*>([^<]+)<\/Name>/;
const TYPE_RE = /<Key>\s*custom_poi\s*<\/Key>\s*<Value>([^<]+)<\/Value>/;
const LON_RE = /<Longitude>([^<]+)<\/Longitude>/;
const LAT_RE = /<Latitude>([^<]+)<\/Latitude>/;
const FROM_RE = /<FromDate>([^<]+)<\/FromDate>/;
const TO_RE = /<ToDate>([^<]+)<\/ToDate>/;

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseNetex(xml: string): ParsedPoi[] {
  const out: ParsedPoi[] = [];
  for (const m of xml.matchAll(PLACE_RE)) {
    const [, idStr, body] = m;
    if (!body) continue;
    const head = body.split(/<Centroid\b/)[0] ?? body;
    const name = NAME_RE.exec(head)?.[1]?.trim();
    const poi_type = TYPE_RE.exec(body)?.[1]?.trim();
    const longitude = Number(LON_RE.exec(body)?.[1]);
    const latitude = Number(LAT_RE.exec(body)?.[1]);
    const valid_from = FROM_RE.exec(body)?.[1]?.trim();
    const valid_to = TO_RE.exec(body)?.[1]?.trim();
    if (
      !name ||
      !poi_type ||
      !valid_from ||
      !valid_to ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      continue;
    }
    const idTail = idStr ? ID_TAIL_RE.exec(idStr) : null;
    out.push({
      id: idTail ? Number(idTail[1]) : undefined,
      name: unescape(name),
      poi_type,
      longitude: Math.round(longitude * 1e5) / 1e5,
      latitude: Math.round(latitude * 1e5) / 1e5,
      valid_from: `${valid_from} Europe/Oslo`,
      valid_to: `${valid_to} Europe/Oslo`,
    });
  }
  return out;
}
