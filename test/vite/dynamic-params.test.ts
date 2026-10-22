import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRouteModule } from "../../src/vite/exports";
import { generateRouteTree } from "../../src/vite/generate";
import { RouteScanError } from "../../src/vite/issues";
import { type ScanResult, scanRoutes } from "../../src/vite/scan";
import { makeTree, PAGE, type TempTree } from "./support/tree";

/*
 * `export const dynamicParams = true | false` (Next parity): with `false`, a param the page's `prerender` export does
 * not list is not found. The scanner reads the literal, refuses everything else by naming the file and the export, and
 * the generator carries the value to the route tree the server reads.
 */

const trees: TempTree[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) tree.dispose();
});

async function scan(files: Record<string, string>): Promise<ScanResult> {
  const tree = makeTree(files);
  trees.push(tree);
  return scanRoutes({ routesDir: tree.root });
}

async function failure(files: Record<string, string>): Promise<RouteScanError> {
  try {
    await scan(files);
  } catch (error) {
    if (error instanceof RouteScanError) return error;
    throw error;
  }
  throw new Error("expected the scan to fail");
}

const LIST = `export const prerender = ["/posts/1", "/posts/2"];\n`;

describe("dynamicParams export", () => {
  it("[DP-S1] the module analysis reads a literal true or false, and nothing else", () => {
    expect(analyzeRouteModule("export const dynamicParams = false;", "a.ts").config).toEqual({
      dynamicParams: false,
    });
    expect(
      analyzeRouteModule("export const dynamicParams = true as const;", "a.ts").config,
    ).toEqual({ dynamicParams: true });
    for (const source of [
      'export const dynamicParams = "force-dynamic";',
      "export const dynamicParams = 0;",
      "export const dynamicParams = process.env.STRICT === '1';",
      "const flag = false; export const dynamicParams = flag;",
    ]) {
      const info = analyzeRouteModule(source, "a.ts");
      expect(info.config, source).toEqual({});
      expect(info.exports, source).toContain("dynamicParams");
    }
  });

  it("[DP-S2] a dynamic page with a prerender list accepts true and false; the value reaches the route entry", async () => {
    for (const value of [true, false]) {
      const result = await scan({
        "posts/[id].tsx": `${PAGE}${LIST}export const dynamicParams = ${value};\n`,
      });
      const entry = result.entries.find((item) => item.id === "/posts/:id");
      expect(entry?.info.config.dynamicParams, String(value)).toBe(value);
    }
  });

  it("[DP-S3] without the export the value is undefined, which means true (an unknown param renders)", async () => {
    const result = await scan({ "posts/[id].tsx": `${PAGE}${LIST}` });
    expect(result.entries[0]?.info.config.dynamicParams).toBeUndefined();
  });

  it("[DP-S4] any other value is a build error that names the file and the export", async () => {
    for (const value of ['"force-dynamic"', "1", "enabled", "!0", "null"]) {
      const error = await failure({
        "posts/[id].tsx": `${PAGE}${LIST}const enabled = false;\nexport const dynamicParams = ${value};\n`,
      });
      const issue = error.issues.find((entry) => entry.code === "ROUTE_DYNAMIC_PARAMS_INVALID");
      expect(issue, value).toBeDefined();
      expect(issue?.files, value).toEqual(["posts/[id].tsx"]);
      expect(issue?.message, value).toContain('"dynamicParams"');
      expect(issue?.message, value).toContain("true or false");
      expect(issue?.message, value).toContain("fix:");
    }
  });

  it("[DP-S5] a re-exported dynamicParams is not a literal either", async () => {
    const error = await failure({
      "posts/[id].tsx": `${PAGE}${LIST}export { dynamicParams } from "./flags";\n`,
    });
    expect(error.issues.map((entry) => entry.code)).toContain("ROUTE_DYNAMIC_PARAMS_INVALID");
  });

  it("[DP-S6] false without a prerender export is a build error: nothing would be listed, so everything would be not found", async () => {
    const error = await failure({
      "posts/[id].tsx": `${PAGE}export const dynamicParams = false;\n`,
    });
    const issue = error.issues.find((entry) => entry.code === "ROUTE_DYNAMIC_PARAMS_INVALID");
    expect(issue?.files).toEqual(["posts/[id].tsx"]);
    expect(issue?.message).toContain("prerender");
    expect(issue?.message).toContain("not found");
    expect(issue?.message).toContain("fix:");
  });

  it("[DP-S7] true without a prerender export is allowed (it is the default)", async () => {
    const result = await scan({
      "posts/[id].tsx": `${PAGE}export const dynamicParams = true;\n`,
    });
    expect(result.entries[0]?.info.config.dynamicParams).toBe(true);
  });

  it("[DP-S8] false on a route whose path has no params is a build error: there is no param to list", async () => {
    const error = await failure({
      "about.tsx": `${PAGE}export const prerender = true;\nexport const dynamicParams = false;\n`,
    });
    const issue = error.issues.find((entry) => entry.code === "ROUTE_DYNAMIC_PARAMS_INVALID");
    expect(issue?.files).toEqual(["about.tsx"]);
    expect(issue?.message).toContain("param");
  });

  it("[DP-S9] only a page takes the export: a layout, an API route and a stream route refuse it", async () => {
    const layout = await failure({
      "posts/_layout.tsx": `${PAGE}${LIST}export const dynamicParams = false;\n`,
      "posts/[id].tsx": PAGE,
    });
    expect(layout.issues.map((entry) => entry.code)).toContain("ROUTE_DYNAMIC_PARAMS_INVALID");
    const api = await failure({
      "api/items/[id].ts": `export function GET() { return new Response("ok"); }\nexport const dynamicParams = true;\n`,
    });
    expect(api.issues.map((entry) => entry.code)).toContain("ROUTE_DYNAMIC_PARAMS_INVALID");
    const stream = await failure({
      "live/[room].ts": `export function SSE() { return null; }\nexport const dynamicParams = true;\n`,
    });
    expect(stream.issues.map((entry) => entry.code)).toContain("ROUTE_DYNAMIC_PARAMS_INVALID");
  });

  it("[DP-S10] the route tree carries the literal to defineRoute; a page without it carries nothing", async () => {
    const tree = makeTree({
      "routes/posts/[id].tsx": `${PAGE}${LIST}export const dynamicParams = false;\n`,
      "routes/docs/[slug].tsx": `${PAGE}${LIST}export const dynamicParams = true;\n`,
      "routes/news/[slug].tsx": `${PAGE}${LIST}`,
    });
    trees.push(tree);
    const text = generateRouteTree(await scanRoutes({ routesDir: join(tree.root, "routes") }), {
      generatedFile: join(tree.root, "routeTree.gen.ts"),
    });
    expect(text).toContain("  dynamicParams: false,\n");
    expect(text).toContain("  dynamicParams: true,\n");
    expect(text.match(/^ {2}dynamicParams:/gm)).toHaveLength(2);
  });
});
