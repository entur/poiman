import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNetex } from "./parse.ts";

const FIXTURE = join(import.meta.dir, "__fixtures__/three_pois.xml");

describe("parseNetex", () => {
  test("parses the three_pois fixture", () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const rows = parseNetex(xml);
    expect(rows).toHaveLength(3);

    const first = rows[0]!;
    expect(first.id).toBe(1);
    expect(first.name).toBe("FOO FIGHTERS Live på Unity Arena, Oslo 10. juni");
    expect(first.poi_type).toBe("concert");
    expect(first.longitude).toBe(10.62535);
    expect(first.latitude).toBe(59.90268);
    expect(first.valid_from).toBe("2026-03-01T00:00:00 Europe/Oslo");
    expect(first.valid_to).toBe("2026-06-10T23:59:00 Europe/Oslo");
  });

  test("ignores POIs with missing required fields", () => {
    const xml = `
      <PublicationDelivery>
        <TopographicPlace id="ENT:TopographicPlace:99">
          <ValidBetween>
            <FromDate>2026-01-01T00:00:00</FromDate>
          </ValidBetween>
          <Name>Missing ToDate</Name>
        </TopographicPlace>
      </PublicationDelivery>
    `;
    expect(parseNetex(xml)).toEqual([]);
  });

  test("decodes XML entities in names", () => {
    const xml = `
      <PublicationDelivery>
        <TopographicPlace id="ENT:TopographicPlace:42">
          <ValidBetween>
            <FromDate>2026-01-01T00:00:00</FromDate>
            <ToDate>2026-12-31T23:59:00</ToDate>
          </ValidBetween>
          <keyList><KeyValue><Key>custom_poi</Key><Value>event</Value></KeyValue></keyList>
          <Name>A &amp; B &quot;test&quot;</Name>
          <Centroid><Location>
            <Longitude>10</Longitude><Latitude>60</Latitude>
          </Location></Centroid>
        </TopographicPlace>
      </PublicationDelivery>
    `;
    const rows = parseNetex(xml);
    expect(rows[0]!.name).toBe('A & B "test"');
  });
});
