import { afterAll, describe, expect, test } from "bun:test";

// Hit the live dev server (docker-compose up). Override with
// POIMAN_TEST_BASE_URL to point at another instance. The whole describe
// block is skipped (reported as skipped, not falsely passing) when the
// server isn't reachable, so contributors who haven't started compose
// still get a clean `bun test` run.
const BASE_URL = process.env.POIMAN_TEST_BASE_URL ?? "http://localhost:8080";
const HEADERS = { "Content-Type": "application/json" };
const TEST_TAG = `__TEST_${Date.now()}`;
const createdIds: number[] = [];

const reachable = await fetch(`${BASE_URL}/liveness`)
  .then((r) => r.ok)
  .catch(() => false);

if (!reachable) {
  console.warn(
    `[server.test] ${BASE_URL} unreachable - skipping integration tests. ` +
      `Run \`docker compose up -d\` to enable them.`,
  );
}

afterAll(async () => {
  if (!reachable) return;
  for (const id of createdIds) {
    await fetch(`${BASE_URL}/api/pois/${id}`, { method: "DELETE" }).catch(
      () => {},
    );
  }
});

const samplePoi = (name: string) => ({
  name,
  poi_type: "event",
  longitude: 10.5,
  latitude: 60,
  valid_from: "2026-01-01T00:00:00Z",
  valid_to: "2026-12-31T23:59:59Z",
});

describe.skipIf(!reachable)("server happy path", () => {
  test("liveness returns ok", async () => {
    const r = await fetch(`${BASE_URL}/liveness`);
    expect(r.status).toBe(200);
    expect((await r.text()).trim()).toBe("ok");
  });

  test("readiness returns ok (db is up)", async () => {
    const r = await fetch(`${BASE_URL}/readiness`);
    expect(r.status).toBe(200);
  });

  test("/config.json has the oidcConfig key", async () => {
    const r = await fetch(`${BASE_URL}/config.json`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { oidcConfig: unknown };
    expect("oidcConfig" in body).toBe(true);
  });

  test("create -> get -> update -> list -> delete round-trip", async () => {
    const name = `${TEST_TAG} round-trip`;

    // CREATE
    const createRes = await fetch(`${BASE_URL}/api/pois`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(samplePoi(name)),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: number; name: string };
    expect(typeof created.id).toBe("number");
    expect(created.name).toBe(name);
    createdIds.push(created.id);

    // GET single
    const getRes = await fetch(`${BASE_URL}/api/pois/${created.id}`);
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { id: number; name: string };
    expect(got.id).toBe(created.id);

    // UPDATE
    const updRes = await fetch(`${BASE_URL}/api/pois/${created.id}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify(samplePoi(`${name} edited`)),
    });
    expect(updRes.status).toBe(200);
    const upd = (await updRes.json()) as { name: string };
    expect(upd.name).toBe(`${name} edited`);

    // LIST contains it
    const listRes = await fetch(`${BASE_URL}/api/pois`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: number; name: string }>;
    expect(list.some((p) => p.id === created.id)).toBe(true);

    // DELETE
    const delRes = await fetch(`${BASE_URL}/api/pois/${created.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(204);

    // After delete, GET single returns 404
    const after = await fetch(`${BASE_URL}/api/pois/${created.id}`);
    expect(after.status).toBe(404);

    // Already deleted; don't try again in afterAll
    createdIds.pop();
  });

  test("rejects writes without an allowed Content-Type (415)", async () => {
    const r = await fetch(`${BASE_URL}/api/pois`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(r.status).toBe(415);
  });

  test("rejects invalid POI input (400)", async () => {
    const r = await fetch(`${BASE_URL}/api/pois`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "" }),
    });
    expect(r.status).toBe(400);
  });

  test("/api/export/netex returns NeTEx XML", async () => {
    const r = await fetch(`${BASE_URL}/api/export/netex`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("xml");
    const xml = await r.text();
    expect(xml).toContain("<?xml");
    expect(xml).toContain("<PublicationDelivery");
    expect(xml).toContain("topographicPlaces");
  });

  test("/api/geocode proxies to the Entur geocoder", async () => {
    const r = await fetch(
      `${BASE_URL}/api/geocode?q=${encodeURIComponent("oslo gate")}`,
    );
    // Upstream is a public Entur API; tolerate transient outages so the
    // test doesn't go red on Entur's dev tier hiccups.
    expect([200, 502, 503, 504]).toContain(r.status);
    if (r.status !== 200) return;
    const body = (await r.json()) as {
      features?: Array<{ geometry: { coordinates: [number, number] } }>;
    };
    expect(Array.isArray(body.features)).toBe(true);
    const first = body.features?.[0];
    if (first) {
      const [lon, lat] = first.geometry.coordinates;
      expect(typeof lon).toBe("number");
      expect(typeof lat).toBe("number");
    }
  });
});
