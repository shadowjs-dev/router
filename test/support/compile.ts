import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@shadow-js/compiler/javascript";

/**
 * Compiles component source with the real ShadowJS compiler and imports the result, so JSX runs
 * through the same module pipeline as user code. Inside `source`, `"@router"` names the router's
 * source entry; it is replaced with its absolute path, because the vitest aliases do not cover this
 * package.
 */

const dir: string = join(import.meta.dirname, "..", ".generated");
/** Each load gets its own module instance, so counters in one test never leak into the next. */
let loads: number = 0;
const ROUTER_ENTRY: string = join(import.meta.dirname, "..", "..", "src", "index.ts");

/** The router entry, for tests that build the router from plain code. */
export const ROUTER_SOURCE: string = ROUTER_ENTRY;

/**
 * Compiles `source` for the browser (`dom`) or the server (`ssr`) and imports it.
 *
 * @param source Component source (TSX).
 * @param target Output flavor.
 * @returns The module namespace.
 */
export async function load<T = Record<string, unknown>>(
  source: string,
  target: "dom" | "ssr" = "dom",
): Promise<T> {
  // "@router/<feature>" names one feature module (its subpath), as the package does. The test feature
  // set (`@router/test-features`) is the support module, so compiled code can build every feature.
  const body = source
    .replaceAll('"@router"', JSON.stringify(ROUTER_ENTRY))
    .replace(/"@router\/([a-z-]+)"/g, (_match, name: string) =>
      JSON.stringify(
        name === "test-features"
          ? join(import.meta.dirname, "features.ts")
          : join(ROUTER_ENTRY, "..", "features", `${name}.ts`),
      ),
    );
  const helpers = ["everyFeature", "featuresWith", "featuresWithout"].filter((name) =>
    body.includes(`${name}(`),
  );
  const text =
    helpers.length === 0
      ? body
      : `import { ${helpers.join(", ")} } from ${JSON.stringify(join(import.meta.dirname, "features.ts"))};\n${body}`;
  mkdirSync(dir, { recursive: true });
  const result = compile(text, { filename: "case.tsx", generate: target });
  loads += 1;
  const name = `${createHash("sha1").update(`${target}:${loads}:${text}`).digest("hex").slice(0, 12)}.ts`;
  const file = join(dir, name);
  writeFileSync(file, result.code);
  return (await import(/* @vite-ignore */ file)) as T;
}
