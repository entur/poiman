// Always use the prd Entur geocoder. It's a public, read-only service
// and is the most stable tier; pinning here avoids a per-env config and
// stops dev/staging flakes propagating into CI.
const GEOCODER_BASE = "https://api.entur.io/geocoder/v2/autocomplete";

const ET_CLIENT_NAME = "entur-poiman";

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function geocode(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return jsonError(400, "missing q");
  if (q.length < 3) {
    return new Response(JSON.stringify({ features: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const upstream = new URL(GEOCODER_BASE);
  upstream.searchParams.set("text", q);
  upstream.searchParams.set("size", "5");
  upstream.searchParams.set("sources", "openaddresses");
  upstream.searchParams.set("lang", "no");
  try {
    const res = await fetch(upstream, {
      headers: {
        "ET-Client-Name": ET_CLIENT_NAME,
        "User-Agent": ET_CLIENT_NAME,
        Accept: "application/json",
      },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("geocoder upstream failed", err);
    return jsonError(502, "geocoder upstream failed");
  }
}
