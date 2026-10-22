import { afterEach, describe, expect, it } from "vitest";
import { RouteScanError } from "../../src/vite/issues";
import { type ScanResult, scanRoutes } from "../../src/vite/scan";
import { makeTree, PAGE, type TempTree } from "./support/tree";

/*
 * Routing audit, area B: scanner tests. Each test name carries its gap id.
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

const API_GET = "export function GET() { return new Response('ok'); }\n";

describe("[G-B5] parallel and intercepting route folders are refused", () => {
  it("[G-B5] a parallel-route folder (@slot) fails the scan with a code and a fix line", async () => {
    const error = await failure({ "@modal/index.tsx": PAGE, "index.tsx": PAGE });
    const issue = error.issues.find((entry) => entry.code === "ROUTE_PARALLEL_UNSUPPORTED");
    expect(issue).toBeDefined();
    expect(issue?.files).toEqual(["@modal/index.tsx"]);
    expect(issue?.message).toContain("@modal");
    expect(issue?.message).toContain("fix:");
  });

  it("[G-B5] a parallel folder nested under a route is refused too", async () => {
    const error = await failure({ "dash/@stats/page.tsx": PAGE, "dash/page.tsx": PAGE });
    expect(error.issues.map((entry) => entry.code)).toContain("ROUTE_PARALLEL_UNSUPPORTED");
  });

  it("[G-B5] intercepting folders (.), (..) and (...) fail the scan, as folders and as files", async () => {
    for (const name of ["(.)photo", "(..)feed", "(...)root"]) {
      const error = await failure({ [`${name}/[id].tsx`]: PAGE });
      const issue = error.issues.find((entry) => entry.code === "ROUTE_INTERCEPT_UNSUPPORTED");
      expect(issue, name).toBeDefined();
      expect(issue?.message, name).toContain("fix:");
    }
    const file = await failure({ "(..)feed.tsx": PAGE });
    expect(file.issues.map((entry) => entry.code)).toContain("ROUTE_INTERCEPT_UNSUPPORTED");
  });

  it("[G-B5] a group, a file starting with @ and a plain folder with parentheses stay routes", async () => {
    const result = await scan({
      "(marketing)/about.tsx": PAGE,
      "@john.tsx": PAGE,
      "tags(v2)/index.tsx": PAGE,
    });
    expect(result.entries.map((entry) => entry.id).sort()).toEqual(
      ["/@john", "/about", "/tags(v2)"].sort(),
    );
  });
});

describe("[G-B10] unsupported segment exports fail the scan", () => {
  // `dynamicParams` is supported now (dynamic-params.test.ts); the other segment exports of Next still fail.
  it("[G-B10] dynamic, runtime and fetchCache fail the scan, naming the export and the replacement", async () => {
    for (const name of ["dynamic", "runtime", "fetchCache"]) {
      const error = await failure({
        "posts.tsx": `${PAGE}export const ${name} = "force-dynamic";\n`,
      });
      const issue = error.issues.find((entry) => entry.code === "ROUTE_EXPORT_UNSUPPORTED");
      expect(issue, name).toBeDefined();
      expect(issue?.files, name).toEqual(["posts.tsx"]);
      expect(issue?.message, name).toContain(`"${name}"`);
      expect(issue?.message, name).toContain("fix:");
    }
  });

  it("[G-B10] the replacement named for dynamic is one of the supported exports", async () => {
    const error = await failure({
      "posts.tsx": `${PAGE}export const dynamic = "force-dynamic";\n`,
    });
    const message = error.issues[0]?.message ?? "";
    expect(message).toMatch(/revalidate|cache|ssr|prerender/);
  });

  it("[G-B10] the same export on an API route fails too", async () => {
    const error = await failure({
      "api/items.ts": `${API_GET}export const runtime = "edge";\n`,
    });
    expect(error.issues.map((entry) => entry.code)).toContain("ROUTE_EXPORT_UNSUPPORTED");
  });

  it("[G-B10] unknown text is untouched: a local, a longer name and a comment mentioning dynamic pass", async () => {
    const result = await scan({
      "posts.tsx": `${PAGE}const dynamic = 1;\n// dynamic import of the editor\nexport const dynamicLabel = "posts";\nexport const runtimeName = "x";\n`,
    });
    expect(result.entries.map((entry) => entry.id)).toEqual(["/posts"]);
  });

  it("[G-B10] the supported options still scan: revalidate, cache, ssr and prerender", async () => {
    const result = await scan({
      "posts.tsx": `${PAGE}export const revalidate = 60;\nexport const ssr = false;\n`,
      "about.tsx": `${PAGE}export const prerender = true;\nexport const cache = { staleSeconds: 30 };\n`,
    });
    expect(result.entries.map((entry) => entry.id).sort()).toEqual(["/about", "/posts"]);
  });
});

describe("[G-B1] the ALL method export (scanner)", () => {
  it("[G-B1] a file exporting ALL is an API route that answers every method", async () => {
    const result = await scan({
      "any.ts": "export function ALL() { return new Response('any'); }\n",
    });
    expect(result.api.map((entry) => entry.id)).toEqual(["/any"]);
    expect(result.api[0]?.methods).toEqual(["ALL"]);
  });

  it("[G-B1] ALL beside GET is allowed: the explicit GET wins at run time", async () => {
    const result = await scan({
      "mixed.ts":
        "export function GET() { return new Response('get'); }\nexport function ALL() { return new Response('any'); }\n",
    });
    expect(result.api[0]?.methods).toEqual(["GET", "ALL"]);
  });

  it("[G-B1] ALL on a path with a page is a page/API conflict for GET and HEAD", async () => {
    const error = await failure({
      "contact.tsx": PAGE,
      "contact.ts": "export function ALL() { return new Response('x'); }\n",
    });
    const conflict = error.issues.find((entry) => entry.code === "ROUTE_PAGE_API_CONFLICT");
    expect(conflict?.message).toContain("GET, HEAD");
  });
});
