import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRouteTree } from "../../src/vite/generate";
import { scanRoutes } from "../../src/vite/scan";
import { stripServerOnlyExports } from "../../src/vite/server-only";
import { makeTree, PAGE, type TempTree } from "./support/tree";

const trees: TempTree[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) tree.dispose();
});

async function scan(files: Record<string, string>) {
  const tree = makeTree(files);
  trees.push(tree);
  const result = await scanRoutes({ routesDir: tree.root });
  return { tree, result };
}

const MIDDLEWARE = "export const middleware = [async (event, next) => next()];\n";

describe("directory middleware: scanning", () => {
  it("[RMW-1] a _middleware file is not a route and is listed with its folder", async () => {
    const { result } = await scan({
      "index.tsx": PAGE,
      "_middleware.ts": MIDDLEWARE,
      "admin/_middleware.ts": MIDDLEWARE,
      "admin/users/[id].tsx": PAGE,
    });
    expect(result.entries.map((entry) => entry.id).sort()).toEqual(["/", "/admin/users/:id"]);
    expect(result.middleware.map((entry) => [entry.file, entry.folder])).toEqual([
      ["_middleware.ts", ""],
      ["admin/_middleware.ts", "admin"],
    ]);
    expect(result.ignored.map((entry) => entry.file)).not.toContain("_middleware.ts");
  });

  it("[RMW-2] a _middleware file never becomes a page at /_middleware, even with no other route", async () => {
    const { result } = await scan({ "_middleware.ts": MIDDLEWARE });
    expect(result.entries).toEqual([]);
    expect(result.api).toEqual([]);
    expect(result.middleware).toHaveLength(1);
  });

  it("[RMW-3] a route file that exports only middleware is a route, not ROUTE_NO_EXPORTS", async () => {
    const { result } = await scan({ "guarded/_layout.tsx": MIDDLEWARE });
    expect(result.entries.map((entry) => entry.id)).toEqual(["/guarded/_layout"]);
  });
});

describe("route middleware: generated tree", () => {
  it("[RMW-4] only routes whose chain runs middleware are marked; the tree never references the middleware export", async () => {
    const { tree, result } = await scan({
      "index.tsx": PAGE,
      "public.tsx": PAGE,
      "admin/_middleware.ts": MIDDLEWARE,
      "admin/users.tsx": PAGE,
      "reports/_layout.tsx": `${PAGE}${MIDDLEWARE}`,
      "reports/daily.tsx": PAGE,
    });
    const text = generateRouteTree(result, { generatedFile: join(tree.root, "routeTree.gen.ts") });
    // The block of one generated route: from its `id` line to the closing `});` of its defineRoute.
    const blockOf = (id: string): string => {
      const start = text.indexOf(`id: ${JSON.stringify(id)},`);
      expect(start).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf("});", start));
    };
    expect(blockOf("/admin/users")).toContain("serverMiddleware: true");
    expect(blockOf("/reports/_layout")).toContain("serverMiddleware: true");
    expect(blockOf("/reports/daily")).toContain("serverMiddleware: true");
    expect(blockOf("/")).not.toContain("serverMiddleware");
    expect(blockOf("/public")).not.toContain("serverMiddleware");
    expect(text).not.toMatch(/m\d+\.middleware\b/);
  });
});

describe("route middleware: the browser copy", () => {
  const SOURCE = [
    'import { redirect } from "@shadow-js/dusk/server";',
    'import { readSession } from "./session.server";',
    "const shared = { role: 'reader' };",
    "export const middleware = [async (event, next) => { if (!readSession(event)) throw redirect('/login'); return next(); }];",
    "export const loader = () => shared;",
    "export default function Page() { return shared.role; }",
    "",
  ].join("\n");

  it("[RMW-5] the browser copy drops the middleware and what only it needed, keeps the rest", () => {
    const stripped = stripServerOnlyExports(SOURCE, "/app/src/routes/admin.tsx", ["middleware"]);
    expect(stripped).toBeDefined();
    const code = stripped?.code ?? "";
    expect(code).not.toContain("middleware");
    expect(code).not.toContain("session.server");
    expect(code).not.toContain("@shadow-js/dusk/server");
    expect(code).toContain("export const loader");
    expect(code).toContain("export default function Page");
    expect(code).toContain("const shared");
  });

  it("[RMW-6] a module without the export is left alone", () => {
    expect(
      stripServerOnlyExports("export const loader = () => 1;\n", "/a/b.tsx", ["middleware"]),
    ).toBeUndefined();
  });
});
