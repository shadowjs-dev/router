import { afterEach, describe, expect, it } from "vitest";
import { analyzeRouteModule } from "../../src/vite/exports";
import { generateRouteTree } from "../../src/vite/generate";
import { RouteScanError } from "../../src/vite/issues";
import { type ScanResult, scanRoutes } from "../../src/vite/scan";
import { makeTree, PAGE, type TempTree } from "./support/tree";

/**
 * File-route side of the A3 grammar: `[[...slug]]`, route groups, conflicts that name their files
 * and carry a fix, the `matchFilters` export and the function form of `prerender`.
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

const ids = (result: ScanResult): string[] => result.entries.map((entry) => entry.id);

describe("file routes: optional catch-all and groups", () => {
  it("[A3-R7] [[...slug]].tsx is the optional catch-all of its folder; [...rest].tsx stays required", async () => {
    const result = await scan({
      "docs/[[...slug]].tsx": PAGE,
      "files/[...rest].tsx": PAGE,
    });
    expect(ids(result).sort()).toEqual(["/docs/*slug?", "/files/*rest"]);
  });

  it("[A3-R7] [[...slug]].tsx at the root is the catch-all of every path", async () => {
    const result = await scan({ "[[...slug]].tsx": PAGE });
    expect(ids(result)).toEqual(["/*slug?"]);
  });

  it("[A3-R7] an optional catch-all folder is refused: it must be a file name, like [...rest]", async () => {
    const error = await failure({ "[[...x]]/y.tsx": PAGE });
    expect(error.issues.map((issue) => issue.code)).toEqual(["ROUTE_SPLAT_NOT_LAST"]);
    expect(error.issues[0]?.files).toEqual(["[[...x]]/y.tsx"]);
  });

  it("[A3-R7] a route group adds no URL segment and its layout wraps only its own folder", async () => {
    const result = await scan({
      "(marketing)/_layout.tsx": PAGE,
      "(marketing)/pricing.tsx": PAGE,
      "app/home.tsx": PAGE,
    });
    expect(ids(result).sort()).toEqual(["/(marketing)/_layout", "/app/home", "/pricing"]);
    const pricing = result.entries.find((entry) => entry.id === "/pricing");
    expect(pricing?.parentId).toBe("/(marketing)/_layout");
    const home = result.entries.find((entry) => entry.id === "/app/home");
    expect(home?.parentId).toBeUndefined();
  });
});

describe("file routes: conflicts name the files and say how to fix them", () => {
  it("[A3-R8] [...rest].tsx and [[...rest]].tsx in one folder are ambiguous, both files named", async () => {
    const error = await failure({
      "docs/[...rest].tsx": PAGE,
      "docs/[[...rest]].tsx": PAGE,
    });
    expect(error.issues.map((issue) => issue.code)).toEqual(["ROUTE_AMBIGUOUS"]);
    expect(error.issues[0]?.files).toEqual(["docs/[...rest].tsx", "docs/[[...rest]].tsx"]);
  });

  it("[A3-R8] an index next to [[...rest]].tsx is ambiguous at the folder root, because both match /docs", async () => {
    const error = await failure({ "docs/index.tsx": PAGE, "docs/[[...rest]].tsx": PAGE });
    expect(error.issues[0]?.code).toBe("ROUTE_AMBIGUOUS");
    expect(error.issues[0]?.path).toBe("/docs");
  });

  it("[A3-R8] an index next to [...rest].tsx is fine: the index answers /docs and the splat the rest", async () => {
    const result = await scan({ "docs/index.tsx": PAGE, "docs/[...rest].tsx": PAGE });
    expect(ids(result).sort()).toEqual(["/docs", "/docs/*rest"]);
  });

  it("[A3-R9] an ambiguity message names a fix", async () => {
    const error = await failure({ "posts/[id].tsx": PAGE, "posts/[slug].tsx": PAGE });
    const message = error.issues[0]?.message ?? "";
    expect(message).toMatch(/fix:/);
  });

  it("[A3-R9] a duplicate message names a fix", async () => {
    const error = await failure({ "about.tsx": PAGE, "about/index.tsx": PAGE });
    expect(error.issues[0]?.code).toBe("ROUTE_DUPLICATE");
    expect(error.issues[0]?.message).toMatch(/fix:/);
  });
});

describe("file routes: matchFilters and the function form of prerender", () => {
  it("[A3-F5] a matchFilters export is a route option, and the generated tree passes it to defineRoute", async () => {
    const tree = makeTree({
      "posts/[id].tsx":
        "export const matchFilters = { id: (value: string) => /^\\d+$/.test(value) };\nexport default function Post() { return null; }\n",
    });
    trees.push(tree);
    const result = await scanRoutes({ routesDir: tree.root });
    expect(result.entries[0]?.info.exports).toContain("matchFilters");
    const text = generateRouteTree(result, { generatedFile: `${tree.root}/routeTree.gen.ts` });
    expect(text).toContain("matchFilters: m0.matchFilters");
  });

  it("[A3-P1] export const prerender = fn is a function, not a literal: the scanner reads no list for it", () => {
    const info = analyzeRouteModule(
      "export const prerender = async ({ params }) => [{ id: '1' }];\nexport default function Post() { return null; }\n",
      "posts/[id].tsx",
    );
    expect(info.exports).toContain("prerender");
    expect(info.config.prerender).toBeUndefined();
  });

  it("[A3-P1] a literal prerender list is still read as a list", () => {
    const info = analyzeRouteModule(
      'export const prerender = ["/posts/1"];\nexport default function Post() { return null; }\n',
      "posts/[id].tsx",
    );
    expect(info.config.prerender).toEqual(["/posts/1"]);
  });
});
