import { ping } from "../db.ts";

export function liveness(): Response {
  return new Response("ok\n", {
    headers: { "Content-Type": "text/plain" },
  });
}

export async function readiness(): Promise<Response> {
  try {
    await ping();
    return new Response("ok\n", {
      headers: { "Content-Type": "text/plain" },
    });
  } catch (err) {
    return new Response(`db unreachable: ${(err as Error).message}\n`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
