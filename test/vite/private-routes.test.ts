import { afterEach, describe, expect, it } from "vitest";
import { RouteScanError } from "../../src/vite/issues";
import { type ScanResult, scanRoutes } from "../../src/vite/scan";
import { makeTree, PAGE, type TempTree } from "./support/tree";

const trees: TempTree[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) tree.dispose();
});

async function scan(files: Record<string, string>): Promise<ScanResult> {
  const tree = makeTree(files);
  trees.push(tree);
  return scanRoutes({ routesDir: tree.root });
}

const API_GET = "export const GET = () => new Response('ok');";

describe("scanRoutes: private (`_`-prefixed) routes", () => {
  it("[PRIV-6] a page under a `_` folder or named `_x` is private; ordinary pages are not", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "_preview/[fileId].tsx": PAGE,
      "posts/[id].tsx": PAGE,
      "_draft.tsx": PAGE,
    });
    const privacy = Object.fromEntries(result.entries.map((entry) => [entry.id, entry.private]));
    expect(privacy).toEqual({
      "/": false,
      "/_preview/:fileId": true,
      "/posts/:id": false,
      "/_draft": true,
    });
  });

  it("[PRIV-7] an API route, a stream route and the pages under a private layout are private", async () => {
    const result = await scan({
      "api/_internal/ping.ts": API_GET,
      "api/open.ts": API_GET,
      "_live/[room].ts": "export const SSE = (event, stream) => {};",
      "_admin/_layout.tsx": PAGE,
      "_admin/dashboard.tsx": PAGE,
      "public.tsx": PAGE,
    });
    expect(result.api.map((api) => [api.id, api.private])).toEqual([
      ["/api/_internal/ping", true],
      ["/api/open", false],
    ]);
    expect(result.streams.map((stream) => [stream.id, stream.private])).toEqual([
      ["/_live/:room", true],
    ]);
    const dashboard = result.entries.find((entry) => entry.id === "/_admin/dashboard");
    expect(dashboard?.private).toBe(true);
    expect(result.entries.find((entry) => entry.id === "/public")?.private).toBe(false);
  });
});

describe("scanRoutes: API routes with matchFilters", () => {
  it("[PRIV-8] an API route that exports matchFilters is marked, so the manifest can carry the rules", async () => {
    const result = await scan({
      "api/posts/[id].ts": `${API_GET}\nexport const matchFilters = { id: /^\\d+$/ };`,
      "api/plain.ts": API_GET,
    });
    expect(result.api.map((api) => [api.id, api.matchFilters])).toEqual([
      ["/api/plain", false],
      ["/api/posts/:id", true],
    ]);
  });
});

describe("scanRoutes: private routes and prerender", () => {
  it("[PRIV-9] a private page that exports prerender is a scan error naming the file (static output would publish it)", async () => {
    const tree = makeTree({
      "_preview/[id].tsx": `${PAGE}\nexport const prerender = () => [];`,
    });
    trees.push(tree);
    let thrown: unknown;
    try {
      await scanRoutes({ routesDir: tree.root });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouteScanError);
    const error = thrown as RouteScanError;
    expect(error.issues.map((issue) => [issue.code, issue.files])).toEqual([
      ["ROUTE_PRIVATE_PRERENDER", ["_preview/[id].tsx"]],
    ]);
  });
});
