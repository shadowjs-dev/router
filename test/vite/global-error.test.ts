import { afterEach, describe, expect, it } from "vitest";
import { RouteScanError } from "../../src/vite/issues";
import { scanRoutes } from "../../src/vite/scan";
import { makeTree, PAGE, type TempTree } from "./support/tree";

const trees: TempTree[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) tree.dispose();
});

async function scan(files: Record<string, string>) {
  const tree = makeTree(files);
  trees.push(tree);
  return scanRoutes({ routesDir: tree.root });
}

describe("scanRoutes: the global error file", () => {
  it("[GERR-1] `_global-error` at the routes root is the global error, not a route", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "_global-error.tsx": PAGE,
      "posts/[id].tsx": PAGE,
    });
    expect(result.globalError?.file).toBe("_global-error.tsx");
    expect(result.entries.map((entry) => entry.id)).toEqual(["/", "/posts/:id"]);
    expect(result.files).toContain("_global-error.tsx");
  });

  it("[GERR-1b] without the file there is no global error; two files for it are one scan error", async () => {
    const plain = await scan({ "index.tsx": PAGE });
    expect(plain.globalError).toBeUndefined();

    const tree = makeTree({ "_global-error.tsx": PAGE, "_global-error.ts": PAGE });
    trees.push(tree);
    let thrown: unknown;
    try {
      await scanRoutes({ routesDir: tree.root });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouteScanError);
    expect((thrown as RouteScanError).issues.map((issue) => issue.code)).toEqual([
      "ROUTE_DUPLICATE",
    ]);
  });
});
