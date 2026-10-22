import { describe, expect, it } from "vitest";
import { ModuleParseError } from "../../src/vite/ast";
import { analyzeRouteModule } from "../../src/vite/exports";

describe("analyzeRouteModule", () => {
  it("[FRT-10] finds every export form", () => {
    const info = analyzeRouteModule(
      `
      export const a = 1, { b, c: [d] } = obj;
      export function e() {}
      export class F {}
      export { g as h, i };
      export { j } from "./other";
      export * as ns from "./ns";
      export default function () {}
      export type T = string;
      export interface I {}
      export enum En { A }
      const g = 1, i = 2;
      `,
      "a.ts",
    );
    expect(info.exports).toEqual(["En", "F", "a", "b", "d", "default", "e", "h", "i", "j", "ns"]);
    expect(info.hasDefault).toBe(true);
    expect(info.hasStarExport).toBe(false);
  });

  it("[FRT-11] type-only exports and declare are not runtime exports", () => {
    const info = analyzeRouteModule(
      `export type { A } from "./a"; export { type B, c }; export declare const d: number; export default interface I {}`,
      "a.ts",
    );
    expect(info.exports).toEqual(["c"]);
    expect(info.hasDefault).toBe(false);
  });

  it("[FRT-12] export * is reported", () => {
    expect(analyzeRouteModule(`export * from "./x";`, "a.ts").hasStarExport).toBe(true);
  });

  it("[FRT-13] HTTP method exports in any form, ordered", () => {
    const info = analyzeRouteModule(
      `export async function POST() {} export const GET = () => 1; const D = 1; export { D as DELETE }; export const get = 1;`,
      "api.ts",
    );
    expect(info.methods).toEqual(["GET", "POST", "DELETE"]);
    expect(info.hasDefault).toBe(false);
  });

  it("[FRT-14] static ssr and prerender literals, through as and satisfies", () => {
    expect(analyzeRouteModule(`export const ssr = false;`, "a.ts").config).toEqual({ ssr: false });
    expect(analyzeRouteModule(`export const ssr = "data-only" as const;`, "a.ts").config).toEqual({
      ssr: "data-only",
    });
    expect(
      analyzeRouteModule(`export const prerender = ["/a", \`/b\`] satisfies string[];`, "a.ts")
        .config,
    ).toEqual({ prerender: ["/a", "/b"] });
    expect(analyzeRouteModule(`export const prerender = true;`, "a.ts").config).toEqual({
      prerender: true,
    });
    expect(analyzeRouteModule(`export const ssr = compute();`, "a.ts").config).toEqual({});
  });

  it("[FRT-16] a default export of apiRoute({...}) from @shadow-js/dusk/server is an API route with its literal methods", () => {
    const info = analyzeRouteModule(
      `import { apiRoute, json } from "@shadow-js/dusk/server";
       export default apiRoute({ POST: () => json(1), GET: () => json(2), csrf: false });`,
      "a.ts",
    );
    expect(info.hasDefault).toBe(true);
    expect(info.defaultApi).toEqual({ methods: ["GET", "POST"], readable: true });
    expect(info.methods).toEqual([]);
  });

  it("[FRT-17] apiRoute is found through an alias, a namespace import, a local binding and an `as` default export", () => {
    const alias = analyzeRouteModule(
      `import { apiRoute as route } from "@shadow-js/dusk/server"; export default route({ GET() {} });`,
      "a.ts",
    );
    expect(alias.defaultApi).toEqual({ methods: ["GET"], readable: true });
    const namespace = analyzeRouteModule(
      `import * as start from "@shadow-js/dusk/server"; export default start.apiRoute({ "DELETE": () => 1 } as const);`,
      "a.ts",
    );
    expect(namespace.defaultApi).toEqual({ methods: ["DELETE"], readable: true });
    const local = analyzeRouteModule(
      `import { apiRoute } from "@shadow-js/dusk/server"; const handlers = apiRoute({ PUT: () => 1 }); export default handlers;`,
      "a.ts",
    );
    expect(local.defaultApi).toEqual({ methods: ["PUT"], readable: true });
    const exported = analyzeRouteModule(
      `import { apiRoute } from "@shadow-js/dusk/server"; const handlers = apiRoute({ PATCH: () => 1 }); export { handlers as default };`,
      "a.ts",
    );
    expect(exported.defaultApi).toEqual({ methods: ["PATCH"], readable: true });
  });

  it("[FRT-18] an apiRoute argument the scanner cannot read statically is reported as not readable", () => {
    for (const argument of ["handlers", "{ ...shared, GET: () => 1 }", "{ [name]: () => 1 }"]) {
      const info = analyzeRouteModule(
        `import { apiRoute } from "@shadow-js/dusk/server"; export default apiRoute(${argument});`,
        "a.ts",
      );
      expect(info.defaultApi?.readable).toBe(false);
    }
  });

  it("[FRT-19] a function that is not the apiRoute of @shadow-js/dusk/server is not an API default", () => {
    const local = analyzeRouteModule(
      `function apiRoute(options: object) { return options; } export default apiRoute({ GET: () => 1 });`,
      "a.ts",
    );
    expect(local.defaultApi).toBeUndefined();
    const other = analyzeRouteModule(
      `import { apiRoute } from "./my-helpers"; export default apiRoute({ GET: () => 1 });`,
      "a.ts",
    );
    expect(other.defaultApi).toBeUndefined();
    const page = analyzeRouteModule(`export default function Page() { return null; }`, "a.tsx");
    expect(page.defaultApi).toBeUndefined();
  });

  it("[FRT-15] TSX and JSX parse; a syntax error carries position and frame", () => {
    expect(analyzeRouteModule(`export default () => <div>{1}</div>;`, "a.tsx").hasDefault).toBe(
      true,
    );
    expect(() => analyzeRouteModule(`export const = ;\n`, "bad.ts")).toThrow(ModuleParseError);
    try {
      analyzeRouteModule(`const a = 1;\nexport const = ;\n`, "bad.ts");
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleParseError);
      if (error instanceof ModuleParseError) {
        expect(error.line).toBe(2);
        expect(error.frame).toContain("^");
      }
    }
  });
});
