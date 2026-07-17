import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The stylesheet is hand-authored with no CSS linter, and a single stray
// brace makes the parser discard rules to the next valid selector - which
// once silently dropped the whole responsive @media block while the build
// still "succeeded". These guard that class of failure.
const REPO = join(import.meta.dir, "..", "..");
const CSS = join(REPO, "src/client/style.css");
const ENTRY = join(REPO, "src/client/main.tsx");

describe("client styles", () => {
  test("braces are balanced", async () => {
    const css = await Bun.file(CSS).text();
    const open = (css.match(/{/g) ?? []).length;
    const close = (css.match(/}/g) ?? []).length;
    expect(open).toBe(close);
  });

  test("responsive @media block survives bundling", async () => {
    const out = await Bun.build({ entrypoints: [ENTRY], target: "browser" });
    expect(out.success).toBe(true);
    const cssOut = out.outputs.find((o) => o.path.endsWith(".css"));
    expect(cssOut).toBeTruthy();
    const text = await cssOut!.text();
    expect(text).toMatch(/@media[^{]*max-width:\s*720px/);
  });
});
