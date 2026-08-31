import { describe, expect, test } from "bun:test";
import { isPoiType, POI_TYPES } from "./poiTypes.ts";

describe("POI_TYPES", () => {
  test("contains the three known types", () => {
    expect(POI_TYPES).toEqual(["concert", "festival", "event"]);
  });
});

describe("isPoiType", () => {
  test("accepts known values", () => {
    expect(isPoiType("concert")).toBe(true);
    expect(isPoiType("festival")).toBe(true);
    expect(isPoiType("event")).toBe(true);
  });

  test("rejects unknown values", () => {
    expect(isPoiType("party")).toBe(false);
    expect(isPoiType("")).toBe(false);
    expect(isPoiType("Concert")).toBe(false); // case-sensitive
  });

  test("rejects non-string input", () => {
    expect(isPoiType(undefined)).toBe(false);
    expect(isPoiType(null)).toBe(false);
    expect(isPoiType(42)).toBe(false);
    expect(isPoiType({ poi_type: "concert" })).toBe(false);
  });
});
