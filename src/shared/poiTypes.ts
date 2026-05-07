// Single source of truth for the POI taxonomy. Imported by server routes
// and the browser bundle alike (Bun's bundler resolves relative paths into
// dist/client/main.js without leaking server-only code).

export const POI_TYPES = ["concert", "festival", "event"] as const;
export type PoiType = (typeof POI_TYPES)[number];

export function isPoiType(s: unknown): s is PoiType {
  return typeof s === "string" && (POI_TYPES as readonly string[]).includes(s);
}
