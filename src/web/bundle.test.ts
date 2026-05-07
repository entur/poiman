import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Guard rail: the browser bundle must not pull in anything from
// `src/server/`. Bun's `--target=browser` silently shims `node:*` and
// happily bundles isomorphic-looking deps (e.g. `jose` runs in browsers
// via WebCrypto), so a stray `import { sql } from "../server/db.ts"` in
// `web/main.tsx` could go undetected. We bundle and assert that no
// server-only marker strings show up in the output.
const REPO = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO, "src/web/main.tsx");

describe("web bundle", () => {
  test("contains no server-only references", async () => {
    const out = await Bun.build({
      entrypoints: [ENTRY],
      target: "browser",
      // No minify - keeps source identifiers intact for the audit.
    });

    expect(out.success).toBe(true);
    expect(out.outputs.length).toBeGreaterThan(0);

    const js = await out.outputs[0]!.text();

    // Module specifiers that have no business in a browser bundle.
    const forbiddenModules = [
      "node:fs",
      "node:path",
      "node:fs/promises",
      "bun:sql",
      "bun:test",
    ];
    for (const m of forbiddenModules) {
      expect(js).not.toContain(m);
    }

    // Symbols that live in server-only files. If any of these appear,
    // a server module got pulled into the bundle.
    const forbiddenSymbols = [
      "DATABASE_URL",
      "createRemoteJWKSet", // jose
      "jwtVerify", // jose
      "POSTGRES_USER",
    ];
    for (const s of forbiddenSymbols) {
      expect(js).not.toContain(s);
    }
  });
});
