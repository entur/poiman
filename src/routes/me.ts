import { userEmail } from "../auth.ts";

export function me(req: Request): Response {
  return new Response(JSON.stringify({ email: userEmail(req) }), {
    headers: { "Content-Type": "application/json" },
  });
}
