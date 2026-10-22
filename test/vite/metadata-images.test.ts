import { afterEach, describe, expect, it } from "vitest";
import { readImageExports } from "../../src/vite/exports";
import { metadataImageKindOf, parseRouteFile } from "../../src/vite/grammar";
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

const IMAGE = "export default function Image() { return null; }\n";

describe("scanRoutes: metadata image files", () => {
  it("[MI-1] a dynamic opengraph-image or twitter-image in a folder is not a page or an API route", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "blog/[slug]/index.tsx": PAGE,
      "blog/[slug]/opengraph-image.tsx": IMAGE,
      "blog/[slug]/twitter-image.ts": IMAGE,
      "(shop)/cart/opengraph-image.jsx": IMAGE,
    });
    expect(result.entries.map((entry) => entry.id)).toEqual(["/blog/:slug", "/"]);
    expect(result.api).toEqual([]);
    expect(result.metadataImages).toEqual([
      {
        file: "(shop)/cart/opengraph-image.jsx",
        absolutePath: expect.stringContaining("opengraph-image.jsx"),
        kind: "openGraph",
        folder: "(shop)/cart",
      },
      {
        file: "blog/[slug]/opengraph-image.tsx",
        absolutePath: expect.stringContaining("opengraph-image.tsx"),
        kind: "openGraph",
        folder: "blog/[slug]",
      },
      {
        file: "blog/[slug]/twitter-image.ts",
        absolutePath: expect.stringContaining("twitter-image.ts"),
        kind: "twitter",
        folder: "blog/[slug]",
      },
    ]);
    expect(result.files).toContain("blog/[slug]/opengraph-image.tsx");
    expect(result.files).toContain("blog/[slug]/twitter-image.ts");
  });

  it("[MI-2] a metadata image at the routes root is listed with the empty folder", async () => {
    const result = await scan({ "index.tsx": PAGE, "opengraph-image.tsx": IMAGE });
    expect(result.entries.map((entry) => entry.id)).toEqual(["/"]);
    expect(result.metadataImages.map((item) => [item.file, item.folder])).toEqual([
      ["opengraph-image.tsx", ""],
    ]);
  });

  it("[MI-3] the names only count as metadata images as files: a folder, a layout and a param stay routes", async () => {
    const result = await scan({
      "opengraph-image/index.tsx": PAGE,
      "[opengraph].tsx": PAGE,
      "blog/_layout.tsx": PAGE,
      "blog/opengraph-image-old.tsx": PAGE,
    });
    expect(result.entries.map((entry) => entry.id).sort()).toEqual([
      "/:opengraph",
      "/blog/_layout",
      "/blog/opengraph-image-old",
      "/opengraph-image",
    ]);
    expect(result.metadataImages).toEqual([]);
  });

  it("[MI-4] a metadata image sits in a private folder without becoming a private route", async () => {
    const result = await scan({ "_draft/opengraph-image.tsx": IMAGE });
    expect(result.entries).toEqual([]);
    expect(result.metadataImages.map((item) => item.folder)).toEqual(["_draft"]);
  });

  it("[MI-5] the grammar says which parsed files are metadata images", () => {
    const parsed = parseRouteFile("a/[id]/opengraph-image.tsx");
    expect(parsed.status === "ok" && metadataImageKindOf(parsed)).toBe("openGraph");
    const twitter = parseRouteFile("a/twitter-image.mjs");
    expect(twitter.status === "ok" && metadataImageKindOf(twitter)).toBe("twitter");
    const layout = parseRouteFile("a/_layout.tsx");
    expect(layout.status === "ok" && metadataImageKindOf(layout)).toBeUndefined();
    const index = parseRouteFile("a/opengraph-image/index.tsx");
    expect(index.status === "ok" && metadataImageKindOf(index)).toBeUndefined();
  });
});

describe("readImageExports: the literal exports of an image module", () => {
  it("[MI-6] alt, size and contentType written as literals are read", () => {
    const facts = readImageExports(
      [
        'export const alt = "A red bicycle";',
        "export const size = { width: 600, height: 315 } as const;",
        'export const contentType: string = "image/png";',
        "export default function Image() { return null; }",
      ].join("\n"),
      "image.tsx",
    );
    expect(facts).toEqual({
      alt: { state: "literal", value: "A red bicycle" },
      size: { state: "literal", value: { width: 600, height: 315 } },
      contentType: { state: "literal", value: "image/png" },
    });
  });

  it("[MI-7] an export the module does not declare is absent; one it declares another way is computed", () => {
    const absent = readImageExports("export default () => null;", "image.tsx");
    expect(absent).toEqual({
      alt: { state: "absent" },
      size: { state: "absent" },
      contentType: { state: "absent" },
    });
    const computed = readImageExports(
      [
        "const label = () => 'x';",
        "export const alt = label();",
        "export const size = makeSize();",
        "const contentType = 'image/png';",
        "export { contentType };",
        "export default () => null;",
      ].join("\n"),
      "image.tsx",
    );
    expect(computed).toEqual({
      alt: { state: "computed" },
      size: { state: "computed" },
      contentType: { state: "computed" },
    });
  });

  it("[MI-8] a size with a missing or non-literal side, or a spread, is computed; a template alt is read", () => {
    const partial = readImageExports(
      "export const size = { width: 600 }; export const alt = `Hello`;",
      "image.tsx",
    );
    expect(partial.size).toEqual({ state: "computed" });
    expect(partial.alt).toEqual({ state: "literal", value: "Hello" });
    const spread = readImageExports(
      "const base = { width: 1, height: 2 }; export const size = { ...base };",
      "image.tsx",
    );
    expect(spread.size).toEqual({ state: "computed" });
  });
});
