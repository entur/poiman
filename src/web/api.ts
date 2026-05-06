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

async function check(res: Response): Promise<Response> {
  if (!res.ok) {
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
  async me(): Promise<{ email: string | null }> {
    return (await check(await fetch("/api/me"))).json();
  },
  async list(): Promise<Poi[]> {
    return (await check(await fetch("/api/pois"))).json();
  },
  async create(input: PoiInput): Promise<Poi> {
    return (
      await check(
        await fetch("/api/pois", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      )
    ).json();
  },
  async remove(id: number): Promise<void> {
    await check(await fetch(`/api/pois/${id}`, { method: "DELETE" }));
  },
  async importNetex(
    xml: string,
    mode: "merge" | "replace",
  ): Promise<{ imported: number; replaced: number; mode: string }> {
    return (
      await check(
        await fetch(`/api/import/netex?mode=${mode}`, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: xml,
        }),
      )
    ).json();
  },
};
