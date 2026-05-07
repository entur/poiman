import { signal } from "@preact/signals";

export type Poi = {
  id: number;
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: string;
  valid_to: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  last_edited_by: string | null;
};

export type PoiInput = {
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: string;
  valid_to: string;
};

// Set by the AuthProvider wrapper on every user/token change. Plain api.ts
// callers don't have access to React hooks, so we mirror the live token in
// a module-level signal and pin it onto every outgoing /api/* request.
// Invariant: AuthenticatedApp returns null until auth.user is set, so by
// the time any code in the app calls into api.*, accessToken.value is set
// (or the app is in dev-bypass mode where no token is needed).
export const accessToken = signal<string | null>(null);

// Set by main.tsx after AuthProvider is mounted. The api fires this on
// 401 so the app can re-authenticate instead of leaving the user stuck
// on a stale-token error banner.
export const onUnauthorized = signal<(() => void) | null>(null);

function authHeaders(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = {};
  if (extra) Object.assign(h, extra);
  if (accessToken.value) h["Authorization"] = `Bearer ${accessToken.value}`;
  return h;
}

async function check(res: Response): Promise<Response> {
  if (!res.ok) {
    if (res.status === 401) onUnauthorized.value?.();
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res;
}

export const api = {
  async list(): Promise<Poi[]> {
    return (
      await check(await fetch("/api/pois", { headers: authHeaders() }))
    ).json();
  },
  async create(input: PoiInput): Promise<Poi> {
    return (
      await check(
        await fetch("/api/pois", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(input),
        }),
      )
    ).json();
  },
  async update(id: number, input: PoiInput): Promise<Poi> {
    return (
      await check(
        await fetch(`/api/pois/${id}`, {
          method: "PUT",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(input),
        }),
      )
    ).json();
  },
  async remove(id: number): Promise<void> {
    await check(
      await fetch(`/api/pois/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
  },
  async searchAddress(
    q: string,
  ): Promise<{ label: string; lon: number; lat: number }[]> {
    const res = await check(
      await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        headers: authHeaders(),
      }),
    );
    const json = (await res.json()) as {
      features?: Array<{
        properties: { label?: string; name?: string };
        geometry: { coordinates: [number, number] };
      }>;
    };
    return (json.features ?? []).map((f) => ({
      label: f.properties.label ?? f.properties.name ?? "",
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
  },
  async importNetex(
    xml: string,
    mode: "merge" | "replace",
  ): Promise<{ imported: number; replaced: number; mode: string }> {
    return (
      await check(
        await fetch(`/api/import/netex?mode=${mode}`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/xml" }),
          body: xml,
        }),
      )
    ).json();
  },
};
