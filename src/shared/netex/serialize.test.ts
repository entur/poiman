import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatOsloIso, type NetexPoi, serializeNetex } from "./serialize.ts";

const FIXTURE = join(import.meta.dir, "__fixtures__/three_pois.xml");

// First three TopographicPlace entries from events_norway_poi.xml.
// Wall-clock times in Europe/Oslo. CET (+01) before 2026-03-29, CEST (+02) after.
const SAMPLE: NetexPoi[] = [
  {
    id: 1,
    name: "FOO FIGHTERS Live på Unity Arena, Oslo 10. juni",
    poi_type: "concert",
    longitude: 10.6253457,
    latitude: 59.9026751,
    valid_from: new Date("2026-03-01T00:00:00+01:00"),
    valid_to: new Date("2026-06-10T23:59:00+02:00"),
  },
  {
    id: 2,
    name: "TONS OF ROCK festival Ekeberg",
    poi_type: "festival",
    longitude: 10.7753778,
    latitude: 59.8980314,
    valid_from: new Date("2026-02-01T12:00:00+01:00"),
    valid_to: new Date("2026-06-28T12:00:00+02:00"),
  },
  {
    id: 3,
    name: "INFERNO METAL FESTIVAL 2026 Oslo",
    poi_type: "festival",
    longitude: 10.7513773,
    latitude: 59.915542,
    valid_from: new Date("2026-02-06T03:00:00+01:00"),
    valid_to: new Date("2026-04-06T03:00:00+02:00"),
  },
];

describe("serializeNetex", () => {
  test("formatOsloIso handles CET and CEST", () => {
    expect(formatOsloIso(new Date("2026-03-01T00:00:00+01:00"))).toBe(
      "2026-03-01T00:00:00",
    );
    expect(formatOsloIso(new Date("2026-06-10T23:59:00+02:00"))).toBe(
      "2026-06-10T23:59:00",
    );
  });

  test("matches the three_pois fixture byte-for-byte", () => {
    const fixture = readFileSync(FIXTURE, "utf8");
    // Late April -> CEST (+02), reproducing the timestamp encoded in the
    // fixture so the comparison is deterministic.
    const fixedNow = new Date("2026-04-27T10:18:55+02:00");
    const generated = serializeNetex(SAMPLE, fixedNow);
    // Trim trailing newline the fixture file picks up from the editor.
    expect(generated.trimEnd()).toBe(fixture.trimEnd());
  });

  test("escapes special characters in names", () => {
    const xml = serializeNetex(
      [
        {
          id: 99,
          name: 'A & B "test" <stuff>',
          poi_type: "event",
          longitude: 10,
          latitude: 60,
          valid_from: new Date("2026-01-01T00:00:00+01:00"),
          valid_to: new Date("2026-12-31T23:59:00+01:00"),
        },
      ],
      new Date("2026-01-01T00:00:00+01:00"),
    );
    expect(xml).toContain("A &amp; B &quot;test&quot; &lt;stuff&gt;");
    expect(xml).not.toContain('"test"</Name>');
  });

  test("empty list still produces valid envelope", () => {
    const xml = serializeNetex([], new Date("2026-01-01T00:00:00+01:00"));
    expect(xml).toContain("<topographicPlaces>");
    expect(xml).toContain("</topographicPlaces>");
    expect(xml).toContain(
      "<PublicationTimestamp>2026-01-01T00:00:00</PublicationTimestamp>",
    );
  });
});
