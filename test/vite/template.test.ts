import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRouteTree } from "../../src/vite/generate";
import { parseRouteFile } from "../../src/vite/grammar";
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

async function generated(files: Record<string, string>): Promise<string> {
  const tree = makeTree(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [`routes/${k}`, v])),
  );
  trees.push(tree);
  const generatedFile = join(tree.root, "routeTree.gen.ts");
  const result = await scanRoutes({ routesDir: join(tree.root, "routes") });
  return generateRouteTree(result, { generatedFile });
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
const entry = (result: ScanResult, id: string) => {
  const found = result.entries.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no entry ${id}; have ${ids(result).join(", ")}`);
  return found;
};

describe("_template: file grammar", () => {
  it.each(["tsx", "ts", "jsx", "js", "mts", "mjs"])(
    "[TPL-01 I-T1] _template.%s is the template of its folder",
    (extension) => {
      const parsed = parseRouteFile(`posts/_template.${extension}`);
      expect(parsed.status).toBe("ok");
      if (parsed.status !== "ok") return;
      expect(parsed.template).toBe(true);
      expect(parsed.layout).toBe(false);
      expect(parsed.leaf).toBeUndefined();
      expect(parsed.dirs.map((dir) => dir.source)).toEqual(["posts"]);
    },
  );

  it("[TPL-02 I-T1] a layout and a page do not carry the template flag", () => {
    for (const path of ["_layout.tsx", "index.tsx", "posts/[id].tsx"]) {
      const parsed = parseRouteFile(path);
      expect(parsed.status).toBe("ok");
      if (parsed.status === "ok") expect(parsed.template).toBeUndefined();
    }
  });
});

describe("_template: scan", () => {
  it("[TPL-10 I-T2] in a folder with a layout, the template sits inside the layout and wraps the pages", async () => {
    const result = await scan({
      "_layout.tsx": PAGE,
      "_template.tsx": PAGE,
      "index.tsx": PAGE,
      "about.tsx": PAGE,
    });
    expect(ids(result)).toEqual(["/_layout", "/_template", "/about", "/"]);
    expect(entry(result, "/_template").parentId).toBe("/_layout");
    expect(entry(result, "/_template").template).toBe(true);
    expect(entry(result, "/_template").path).toBe("");
    expect(entry(result, "/about").parentId).toBe("/_template");
    expect(entry(result, "/").parentId).toBe("/_template");
    expect(entry(result, "/_layout").template).toBeUndefined();
    expect(result.roots.map((root) => root.id)).toEqual(["/_layout"]);
  });

  it("[TPL-11 I-T2] a template in a folder with no layout still wraps the folder", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "posts/_template.tsx": PAGE,
      "posts/[id].tsx": PAGE,
    });
    expect(ids(result)).toEqual(["/", "/posts/_template", "/posts/:id"]);
    const template = entry(result, "/posts/_template");
    expect(template.parentId).toBeUndefined();
    expect(template.path).toBe("/posts");
    expect(template.fullPath).toBe("/posts");
    expect(template.isEndpoint).toBe(false);
    expect(entry(result, "/posts/:id").parentId).toBe("/posts/_template");
    expect(entry(result, "/posts/:id").path).toBe("/:id");
    // The page outside the folder is not wrapped.
    expect(entry(result, "/").parentId).toBeUndefined();
  });

  it("[TPL-12 I-T3] nested templates and layouts compose, outermost first", async () => {
    const result = await scan({
      "_layout.tsx": PAGE,
      "_template.tsx": PAGE,
      "dash/_layout.tsx": PAGE,
      "dash/_template.tsx": PAGE,
      "dash/index.tsx": PAGE,
    });
    expect(ids(result)).toEqual([
      "/_layout",
      "/_template",
      "/dash/_layout",
      "/dash/_template",
      "/dash",
    ]);
    expect(entry(result, "/dash/_layout").parentId).toBe("/_template");
    expect(entry(result, "/dash/_template").parentId).toBe("/dash/_layout");
    expect(entry(result, "/dash").parentId).toBe("/dash/_template");
    expect(entry(result, "/dash/_layout").path).toBe("/dash");
    expect(entry(result, "/dash/_template").path).toBe("");
  });

  it("[TPL-13 I-T3] a template two folders up still wraps a page below a layout-free folder", async () => {
    const result = await scan({
      "_template.tsx": PAGE,
      "a/b/index.tsx": PAGE,
      "a/_template.tsx": PAGE,
    });
    expect(entry(result, "/a/b").parentId).toBe("/a/_template");
    expect(entry(result, "/a/_template").parentId).toBe("/_template");
    expect(entry(result, "/a/_template").path).toBe("/a");
  });

  it("[TPL-14 I-T2] a template inside a route group has the group in its id and adds no segment", async () => {
    const result = await scan({
      "(auth)/_template.tsx": PAGE,
      "(auth)/login.tsx": PAGE,
    });
    expect(ids(result)).toEqual(["/(auth)/_template", "/login"]);
    expect(entry(result, "/(auth)/_template").path).toBe("");
    expect(entry(result, "/login").parentId).toBe("/(auth)/_template");
    expect(entry(result, "/login").path).toBe("/login");
  });

  it("[TPL-15 I-T4] a template with nothing to wrap is not a route, but its file is still read", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "empty/_template.tsx": PAGE,
    });
    expect(ids(result)).toEqual(["/"]);
    expect(result.files).toContain("empty/_template.tsx");
  });

  it("[TPL-16 I-T4] a layout whose only child is an empty template stays an endpoint", async () => {
    const result = await scan({
      "_layout.tsx": PAGE,
      "_template.tsx": PAGE,
    });
    expect(ids(result)).toEqual(["/_layout"]);
    expect(entry(result, "/_layout").isEndpoint).toBe(true);
  });

  it("[TPL-17 I-T5] two template files in one folder are a duplicate", async () => {
    const error = await failure({
      "_template.tsx": PAGE,
      "_template.ts": PAGE,
      "index.tsx": PAGE,
    });
    expect(error.issues.map((issue) => issue.code)).toEqual(["ROUTE_DUPLICATE"]);
    expect(error.issues[0]?.message).toContain('same template "/_template"');
  });

  it("[TPL-18 I-T5] a template without a default export is refused with what to write", async () => {
    const error = await failure({
      "_template.tsx": "export const loader = () => 1;\n",
      "index.tsx": PAGE,
    });
    expect(error.issues.map((issue) => issue.code)).toEqual(["ROUTE_NO_EXPORTS"]);
    expect(error.issues[0]?.message).toContain("template");
    expect(error.issues[0]?.message).toContain("default");
  });

  it("[TPL-19 I-T5] a template is not an API route", async () => {
    const error = await failure({
      "_template.ts": "export const GET = () => new Response('x');\n",
      "index.tsx": PAGE,
    });
    expect(error.issues.map((issue) => issue.code)).toEqual(["ROUTE_MIXED_EXPORTS"]);
    expect(error.issues[0]?.message).toContain("template");
  });
});

describe("_template: route tree", () => {
  it("[TPL-30 I-T6] a tree without a template is byte-identical to the output before templates existed", async () => {
    const text = await generated({
      "_layout.tsx": PAGE,
      "index.tsx": PAGE,
      "about.tsx": PAGE,
      "blog/_layout.tsx": PAGE,
      "blog/index.tsx": PAGE,
      "blog/[slug].tsx": PAGE,
    });
    expect(text).toBe(
      [
        "// @generated by @shadow-js/router/vite. Do not edit: this file is rewritten when route files change.",
        "// biome-ignore-all lint: generated file",
        "// biome-ignore-all format: generated file",
        "// biome-ignore-all assist/source/organizeImports: generated file",
        "/* eslint-disable */",
        'import { defineRoute, type RouterFeature } from "@shadow-js/router";',
        'import * as m0 from "./routes/_layout";',
        'import * as m1 from "./routes/about";',
        'import * as m2 from "./routes/blog/_layout";',
        'import * as m3 from "./routes/blog/[slug]";',
        'import * as m4 from "./routes/blog/index";',
        'import * as m5 from "./routes/index";',
        "",
        'const r1 = defineRoute("/about", {',
        '  id: "/about",',
        "  component: m1.default,",
        "});",
        'const r3 = defineRoute("/:slug", {',
        '  id: "/blog/:slug",',
        "  component: m3.default,",
        "});",
        'const r4 = defineRoute("", {',
        '  id: "/blog",',
        "  component: m4.default,",
        "});",
        'const r2 = defineRoute("/blog", {',
        '  id: "/blog/_layout",',
        "  component: m2.default,",
        "  children: [r3, r4],",
        "});",
        'const r5 = defineRoute("", {',
        '  id: "/",',
        "  component: m5.default,",
        "});",
        'const r0 = defineRoute("", {',
        '  id: "/_layout",',
        "  component: m0.default,",
        "  children: [r1, r2, r5],",
        "});",
        "",
        "export const routeTree = [r0] as const;",
        "",
        "/** The router features the routes of this tree need: `createRouter({ routes: routeTree, features: routerFeatures })`. */",
        "export const routerFeatures: readonly RouterFeature[] = [];",
        "",
        '/** Every route by id: pages by URL pattern, layouts by folder + "/_layout". */',
        "export const routes = {",
        '  "/_layout": r0,',
        '  "/about": r1,',
        '  "/blog/_layout": r2,',
        '  "/blog/:slug": r3,',
        '  "/blog": r4,',
        '  "/": r5,',
        "} as const;",
        "",
        "/** Static facts about each route, read from its source. */",
        'export const routeMeta: Readonly<Record<string, { readonly kind: "page" | "layout"; readonly file: string; readonly ssr?: boolean | "data-only"; readonly prerender?: boolean | readonly string[] }>> = {',
        '  "/_layout": { kind: "layout", file: "_layout.tsx" },',
        '  "/about": { kind: "page", file: "about.tsx" },',
        '  "/blog/_layout": { kind: "layout", file: "blog/_layout.tsx" },',
        '  "/blog/:slug": { kind: "page", file: "blog/[slug].tsx" },',
        '  "/blog": { kind: "page", file: "blog/index.tsx" },',
        '  "/": { kind: "page", file: "index.tsx" },',
        "};",
        "",
        "function preloadComponent(component: unknown): Promise<unknown> {",
        '  if (typeof component === "function" && "preload" in component && typeof component.preload === "function") {',
        "    return Promise.resolve(component.preload());",
        "  }",
        "  return Promise.resolve();",
        "}",
        "",
        "const lazyComponents: Readonly<Record<string, readonly unknown[]>> = {",
        '  "/_layout": [m0.default],',
        '  "/about": [m1.default],',
        '  "/blog/_layout": [m2.default],',
        '  "/blog/:slug": [m3.default],',
        '  "/blog": [m4.default],',
        '  "/": [m5.default],',
        "};",
        "",
        "/**",
        " * Loads the lazily split components of routes (all routes when `ids` is omitted). Await it",
        " * before hydrating, so the first client render finds the code the server rendered.",
        " */",
        "export function preloadRoutes(ids?: readonly string[]): Promise<void> {",
        "  const wanted = ids ?? Object.keys(lazyComponents);",
        "  const loads: Promise<unknown>[] = [];",
        "  for (const id of wanted) {",
        "    for (const component of lazyComponents[id] ?? []) loads.push(preloadComponent(component));",
        "  }",
        "  return Promise.all(loads).then(() => undefined);",
        "}",
        "",
        'declare module "@shadow-js/router" {',
        "  interface Register {",
        '    paths: "/" | "/about" | "/blog" | "/blog/:slug";',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("defineTemplate");
  });

  it("[TPL-31 I-T6] a tree with a template names its module, wraps it, and imports the wrapper once", async () => {
    const text = await generated({
      "_layout.tsx": PAGE,
      "_template.tsx": PAGE,
      "index.tsx": PAGE,
      "blog/_template.tsx": PAGE,
      "blog/[slug].tsx": PAGE,
    });
    expect(text).toContain(
      'import { defineRoute, defineTemplate, type RouterFeature } from "@shadow-js/router";',
    );
    expect(text.match(/defineTemplate\(/g)).toHaveLength(2);
    expect(text).toContain('import * as m1 from "./routes/_template";');
    expect(text).toContain('import * as m2 from "./routes/blog/_template";');
    // The template is a pathless route inside the layout; the pages hang from it.
    expect(text).toContain(
      [
        'const r1 = defineRoute("", {',
        '  id: "/_template",',
        "  component: defineTemplate(m1.default),",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        'const r2 = defineRoute("/blog", {',
        '  id: "/blog/_template",',
        "  component: defineTemplate(m2.default),",
      ].join("\n"),
    );
    expect(text).toMatch(/id: "\/_layout",\n {2}component: m0\.default,\n {2}children: \[r1\],/);
    expect(text).toMatch(
      /id: "\/_template",\n {2}component: defineTemplate\(m1\.default\),\n {2}children: \[r2, r4\],/,
    );
    // The lazy-component list names the plain module export, so preloading finds `.preload`.
    expect(text).toContain('"/_template": [m1.default],');
  });
});
