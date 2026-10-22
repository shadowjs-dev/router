import { describe, expect, it } from "vitest";
import { parseModule } from "../../src/vite/ast";
import { type PruneOptions, pruneModule } from "../../src/vite/prune";

function prune(code: string, options: PruneOptions = {}, file = "x.ts"): string {
  return pruneModule(parseModule(code, file), options).code;
}

describe("pruneModule", () => {
  it("[FRT-70] removes unused imports, partially and entirely", () => {
    const code = [
      `import a, { b, c as d } from "m1";`,
      `import * as ns from "m2";`,
      `import { e } from "m3";`,
      `import f from "m4";`,
      `export const x = b + e;`,
      ``,
    ].join("\n");
    expect(prune(code)).toBe(
      [`import { b } from "m1";`, `import { e } from "m3";`, `export const x = b + e;`, ``].join(
        "\n",
      ),
    );
  });

  it("[FRT-71] keeps side-effect imports and reports them", () => {
    const parsed = parseModule(
      `import "./boot"; import { a } from "m"; export const x = 1;`,
      "x.ts",
    );
    const result = pruneModule(parsed);
    expect(result.code).toBe(`import "./boot"; export const x = 1;`);
    expect(result.sideEffectImports).toEqual(["./boot"]);
    expect(result.removed).toEqual(["a"]);
  });

  it("[FRT-72] removes unused declarations transitively and keeps exports and effects", () => {
    const code = [
      `const unusedA = 1;`,
      `const usedB = 2, unusedC = usedB + 1;`,
      `function helper() { return usedB; }`,
      `function orphan() { return unusedA; }`,
      `class K {}`,
      `export const x = helper();`,
      `console.log("side effect");`,
      ``,
    ].join("\n");
    expect(prune(code)).toBe(
      [
        `const usedB = 2;`,
        `function helper() { return usedB; }`,
        `export const x = helper();`,
        `console.log("side effect");`,
        ``,
      ].join("\n"),
    );
  });

  it("[FRT-73] keepExports drops the other exports and what only they needed", () => {
    const code = [
      `import { db } from "./db";`,
      `import { z } from "zod";`,
      `const schema = z.string();`,
      `export const loader = () => db.get();`,
      `export const validateSearch = (s) => schema.parse(s);`,
      `export default function Page() { return 1; }`,
      ``,
    ].join("\n");
    expect(prune(code, { keepExports: new Set(["loader"]) })).toBe(
      [`import { db } from "./db";`, `export const loader = () => db.get();`, ``].join("\n"),
    );
    expect(prune(code, { keepExports: new Set(["default"]) })).toBe(
      [`export default function Page() { return 1; }`, ``].join("\n"),
    );
  });

  it("[FRT-74] export specifiers and declarators are removed individually, commas included", () => {
    expect(
      prune(`const a = 1, b = 2, c = 3; export { a, b as bee, c };`, {
        keepExports: new Set(["bee"]),
      }),
    ).toBe(`const b = 2; export { b as bee };`);
    expect(prune(`export const a = 1, b = 2, c = 3;`, { keepExports: new Set(["a", "c"]) })).toBe(
      `export const a = 1, c = 3;`,
    );
    expect(prune(`export const a = 1, b = 2, c = 3;`, { keepExports: new Set(["b"]) })).toBe(
      `export const b = 2;`,
    );
    expect(prune(`export const a = 1, b = 2;`, { keepExports: new Set(["a"]) })).toBe(
      `export const a = 1;`,
    );
    expect(prune(`export const a = 1, b = 2, c = 3;`, { keepExports: new Set(["a"]) })).toBe(
      `export const a = 1;`,
    );
  });

  it("[FRT-75] re-exports and default exports follow keepExports", () => {
    const code = `export { x } from "./x"; export * from "./all"; export default () => 1; export const keep = 1;`;
    expect(prune(code, { keepExports: new Set(["keep"]) })).toBe(`export const keep = 1;`);
    expect(prune(code, { keepExports: new Set(["x", "default"]) })).toBe(
      `export { x } from "./x"; export default () => 1;`,
    );
  });

  it("[FRT-76] shadowed names do not keep module-level declarations alive", () => {
    const code = [
      `import { secret } from "./server";`,
      `export function run(secret) { return secret + 1; }`,
      `export function other() { const secret = 2; return secret; }`,
      ``,
    ].join("\n");
    expect(prune(code)).toBe(
      [
        `export function run(secret) { return secret + 1; }`,
        `export function other() { const secret = 2; return secret; }`,
        ``,
      ].join("\n"),
    );
  });

  it("[FRT-77] JSX component references keep their imports, intrinsic elements do not", () => {
    const code = `import Chart from "./chart"; import Icon from "./icon"; export default () => <div><Chart /></div>;`;
    expect(prune(code, {}, "x.tsx")).toBe(
      `import Chart from "./chart"; export default () => <div><Chart /></div>;`,
    );
  });

  it("[FRT-78] type-only syntax stays, and imports used only as types are dropped", () => {
    const code = `import { Foo } from "./foo"; import type { Bar } from "./bar"; export type T = Foo; export const x: Bar = 1;`;
    expect(prune(code)).toBe(
      `import type { Bar } from "./bar"; export type T = Foo; export const x: Bar = 1;`,
    );
  });

  it("[FRT-79] removable restricts removal to what the edit made unused", () => {
    const code = `import { a } from "./a"; import { used } from "./u"; const dead = 1; export const x = used;`;
    const result = pruneModule(parseModule(code, "x.ts"), { removable: new Set(["a"]) });
    expect(result.code).toBe(`import { used } from "./u"; const dead = 1; export const x = used;`);
  });

  it("[FRT-80] roots outside the removable set keep their dependencies", () => {
    const code = `import { a } from "./a"; const keepMe = a; export const x = 1;`;
    const result = pruneModule(parseModule(code, "x.ts"), { removable: new Set(["a"]) });
    expect(result.code).toBe(code);
    expect(result.changed).toBe(false);
  });

  it("[FRT-81] prepend and append go through the source map", () => {
    const parsed = parseModule(`export const a = 1;\n`, "x.ts");
    const result = pruneModule(parsed, { prepend: "// head\n", append: "// tail\n" });
    expect(result.code).toBe(`// head\nexport const a = 1;\n// tail\n`);
    expect(result.map?.mappings).not.toBe("");
  });

  it("[FRT-82] the source map points kept code at its original lines", () => {
    const code = `const dead = 1;\nexport const kept = 2;\n`;
    const result = pruneModule(parseModule(code, "x.ts"));
    expect(result.code).toBe(`export const kept = 2;\n`);
    expect(result.map?.sources).toEqual(["x.ts"]);
    expect(result.map?.sourcesContent).toEqual([code]);
  });

  it("[FRT-83] a module with nothing to remove is returned unchanged without a map", () => {
    const code = `import { a } from "./a"; export const b = a;`;
    const result = pruneModule(parseModule(code, "x.ts"));
    expect(result).toMatchObject({ code, changed: false, map: null, removed: [] });
  });

  it("[FRT-84] a 5000-statement module is analyzed without stack growth", () => {
    const lines: string[] = [];
    for (let index = 0; index < 5000; index += 1)
      lines.push(`const v${index} = ${index > 0 ? `v${index - 1} + ` : ""}1;`);
    lines.push("export const last = v4999;");
    const result = pruneModule(parseModule(lines.join("\n"), "big.ts"), {
      keepExports: new Set(["last"]),
    });
    expect(result.changed).toBe(false);
    const dropped = pruneModule(parseModule(lines.join("\n"), "big.ts"), {
      keepExports: new Set(),
    });
    expect(dropped.code.trim()).toBe("");
  });
});
