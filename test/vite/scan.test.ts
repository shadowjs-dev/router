import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouteScanError } from "../../src/vite/issues";
import { type ScanResult, scanRoutes } from "../../src/vite/scan";
import { makeTree, PAGE, type TempTree } from "./support/tree";

const trees: TempTree[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) tree.dispose();
});

async function scan(files: Record<string, string>, extra = {}): Promise<ScanResult> {
  const tree = makeTree(files);
  trees.push(tree);
  return scanRoutes({ routesDir: tree.root, ...extra });
}

async function failure(files: Record<string, string>, extra = {}): Promise<RouteScanError> {
  try {
    await scan(files, extra);
  } catch (error) {
    if (error instanceof RouteScanError) return error;
    throw error;
  }
  throw new Error("expected the scan to fail");
}

const ids = (result: ScanResult): string[] => result.entries.map((entry) => entry.id);

describe("scanRoutes: conventions", () => {
  it("[FRT-20] maps files to paths with ids equal to the full pattern", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "about.tsx": PAGE,
      "posts/index.tsx": PAGE,
      "posts/[id].tsx": PAGE,
      "[[lang]]/help.tsx": PAGE,
      "files/[...rest].tsx": PAGE,
      "(marketing)/pricing.tsx": PAGE,
    });
    // Siblings are ordered by file name (code-unit order), which is machine independent.
    expect(ids(result)).toEqual([
      "/pricing",
      "/:lang?/help",
      "/about",
      "/files/*rest",
      "/",
      "/posts/:id",
      "/posts",
    ]);
    expect(result.roots).toHaveLength(7);
    expect(result.files).toHaveLength(7);
  });

  it("[FRT-21] _layout wraps siblings and children; paths are relative to the parent layout", async () => {
    const result = await scan({
      "_layout.tsx": PAGE,
      "index.tsx": PAGE,
      "posts/_layout.tsx": PAGE,
      "posts/index.tsx": PAGE,
      "posts/[id].tsx": PAGE,
      "posts/[id]/comments.tsx": PAGE,
      "(auth)/_layout.tsx": PAGE,
      "(auth)/login.tsx": PAGE,
    });
    const byId = new Map(result.entries.map((entry) => [entry.id, entry]));
    expect([...byId.keys()].sort()).toEqual([
      "/",
      "/(auth)/_layout",
      "/_layout",
      "/login",
      "/posts",
      "/posts/:id",
      "/posts/:id/comments",
      "/posts/_layout",
    ]);
    expect(result.roots.map((root) => root.id)).toEqual(["/_layout"]);
    expect(byId.get("/_layout")?.children.map((c) => c.id)).toEqual([
      "/(auth)/_layout",
      "/",
      "/posts/_layout",
    ]);
    const layout = byId.get("/posts/_layout");
    expect(layout?.path).toBe("/posts");
    expect(layout?.parentId).toBe("/_layout");
    expect(layout?.isEndpoint).toBe(false);
    expect(byId.get("/posts")?.path).toBe("");
    expect(byId.get("/posts/:id")?.path).toBe("/:id");
    expect(byId.get("/posts/:id/comments")?.path).toBe("/:id/comments");
    expect(byId.get("/posts/:id/comments")?.parentId).toBe("/posts/_layout");
    expect(byId.get("/(auth)/_layout")?.path).toBe("");
    expect(byId.get("/login")?.path).toBe("/login");
    expect(byId.get("/login")?.parentId).toBe("/(auth)/_layout");
  });

  it("[FRT-22] a layout without children is an endpoint", async () => {
    const result = await scan({ "solo/_layout.tsx": PAGE });
    expect(result.entries[0]?.isEndpoint).toBe(true);
  });

  it("[FRT-23] ignores -name, dot files, tests, css, declarations and node_modules", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "-components/Button.tsx": "export const x = (",
      "-helper.ts": "garbage(((",
      ".hidden.tsx": "garbage(((",
      "style.css": "a{}",
      "index.test.tsx": "garbage(((",
      "types.d.ts": "garbage(((",
      "routeTree.gen.ts": "garbage(((",
      "node_modules/pkg/index.tsx": "garbage(((",
      "README.md": "# hi",
    });
    expect(ids(result)).toEqual(["/"]);
    const reasons = Object.fromEntries(result.ignored.map((item) => [item.file, item.reason]));
    expect(reasons["style.css"]).toBe("extension");
    expect(reasons["index.test.tsx"]).toBe("test-file");
    expect(reasons["-helper.ts"]).toBe("dash-prefix");
  });

  it("[FRT-24] files with HTTP method exports and no default export are API routes", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "api/users/[id].ts": "export const GET = () => 1; export function DELETE() {}",
      "api/health.ts": "export const GET = () => new Response('ok');",
      "api/index.ts": "export async function POST() {}",
    });
    expect(ids(result)).toEqual(["/"]);
    expect(result.api.map((api) => [api.id, api.methods])).toEqual([
      ["/api/health", ["GET"]],
      ["/api", ["POST"]],
      ["/api/users/:id", ["GET", "DELETE"]],
    ]);
  });

  it("[FRT-140] a default export of apiRoute({...}) is an API route, not a page", async () => {
    const result = await scan({
      "index.tsx": PAGE,
      "api/posts/[id].ts": `import { apiRoute, json } from "@shadow-js/dusk/server";
export default apiRoute({ GET: (event) => json({ id: event.params.id }), POST: () => json(1) });
`,
    });
    expect(ids(result)).toEqual(["/"]);
    expect(result.api.map((api) => [api.id, api.methods])).toEqual([
      ["/api/posts/:id", ["GET", "POST"]],
    ]);
  });

  it("[FRT-141] a default apiRoute conflicts with a page on the same path and method", async () => {
    const error = await failure({
      "posts.tsx": PAGE,
      "posts.ts": `import { apiRoute } from "@shadow-js/dusk/server"; export default apiRoute({ GET: () => 1 });`,
    });
    expect(error.issues.map((i) => [i.code, i.files])).toEqual([
      ["ROUTE_PAGE_API_CONFLICT", ["posts.ts", "posts.tsx"]],
    ]);
  });

  it("[FRT-142] an apiRoute argument that is not a literal fails the scan, naming the file and the fix", async () => {
    const error = await failure({
      "api/x.ts": `import { apiRoute } from "@shadow-js/dusk/server"; import { shared } from "./-shared"; export default apiRoute(shared);`,
    });
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.code).toBe("ROUTE_API_NOT_READABLE");
    expect(error.issues[0]?.files).toEqual(["api/x.ts"]);
    expect(error.issues[0]?.message).toContain("object literal");
    expect(error.issues[0]?.message).toContain("export const { GET }");
  });

  it("[FRT-143] a default apiRoute with no HTTP method fails the scan", async () => {
    const error = await failure({
      "api/x.ts": `import { apiRoute } from "@shadow-js/dusk/server"; export default apiRoute({ csrf: false });`,
    });
    expect(error.issues[0]?.code).toBe("ROUTE_API_NOT_READABLE");
    expect(error.issues[0]?.message).toContain("no HTTP method");
  });

  it("[FRT-144] a default apiRoute next to method exports or in a layout is a mixed-exports error", async () => {
    const api = `import { apiRoute } from "@shadow-js/dusk/server"; export default apiRoute({ GET: () => 1 });`;
    const error = await failure({
      "a.ts": `${api}\nexport const POST = () => 1;`,
      "_layout.ts": api,
    });
    expect(error.issues.map((i) => [i.code, i.files])).toEqual([
      ["ROUTE_MIXED_EXPORTS", ["_layout.ts"]],
      ["ROUTE_MIXED_EXPORTS", ["a.ts"]],
    ]);
  });

  it("[FRT-25] a page and an API route may share a path when the API claims only other methods", async () => {
    const result = await scan({
      "contact.tsx": PAGE,
      "contact.ts": "export const POST = () => 1;",
    });
    expect(ids(result)).toEqual(["/contact"]);
    expect(result.api[0]?.id).toBe("/contact");
  });

  it("[FRT-26] route modules with only options (a redirect page) are pages", async () => {
    const result = await scan({
      "old.ts":
        "import { redirect } from '@shadow-js/router'; export const beforeLoad = () => { throw redirect('/'); };",
    });
    expect(ids(result)).toEqual(["/old"]);
    expect(result.entries[0]?.info.hasDefault).toBe(false);
  });

  it("[FRT-27] results are identical across runs and independent of creation order", async () => {
    const files = {
      "b.tsx": PAGE,
      "a.tsx": PAGE,
      "c/[x].tsx": PAGE,
      "c/index.tsx": PAGE,
      "api/z.ts": "export const GET = 1;",
    };
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const first = await scan(files);
    const second = await scan(reversed);
    const strip = (r: ScanResult): unknown =>
      JSON.parse(
        JSON.stringify({
          e: r.entries.map((e) => [e.id, e.file, e.path, e.parentId]),
          a: r.api.map((a) => a.id),
          f: r.files,
        }),
      );
    expect(strip(first)).toEqual(strip(second));
  });
});

describe("scanRoutes: build errors name the files", () => {
  it("[FRT-30] duplicate inferred paths", async () => {
    const error = await failure({
      "posts.tsx": PAGE,
      "posts/index.tsx": PAGE,
      "(g)/posts.tsx": PAGE,
    });
    const codes = error.issues.map((issue) => issue.code);
    expect(codes).toEqual(["ROUTE_DUPLICATE"]);
    expect(error.issues[0]?.files).toEqual(["(g)/posts.tsx", "posts.tsx", "posts/index.tsx"]);
    expect(error.message).toContain("file: posts/index.tsx");
    expect(error.message).toContain("file: posts.tsx");
  });

  it("[FRT-31] param names do not tell routes apart (ambiguous)", async () => {
    const error = await failure({ "posts/[id].tsx": PAGE, "posts/[slug].tsx": PAGE });
    expect(error.issues[0]?.code).toBe("ROUTE_AMBIGUOUS");
    expect(error.issues[0]?.files).toEqual(["posts/[id].tsx", "posts/[slug].tsx"]);
  });

  it("[FRT-32] letter case does not tell routes apart on any file system", async () => {
    // Different folders, so the test also runs on case-insensitive file systems (macOS, Windows).
    const files = { "(one)/About.tsx": PAGE, "(two)/about.tsx": PAGE };
    const error = await failure(files);
    expect(error.issues[0]?.code).toBe("ROUTE_AMBIGUOUS");
    expect(error.issues[0]?.files).toEqual(["(one)/About.tsx", "(two)/about.tsx"]);
    const sensitive = await scan(files, { caseSensitive: true });
    expect(ids(sensitive)).toEqual(["/About", "/about"]);
  });

  it("[FRT-33] an optional segment that overlaps a plain route is ambiguous", async () => {
    const error = await failure({ "index.tsx": PAGE, "[[lang]]/index.tsx": PAGE });
    expect(error.issues[0]?.code).toBe("ROUTE_AMBIGUOUS");
    expect(error.issues[0]?.path).toBe("/");
  });

  it("[FRT-34] two optionals at the same place conflict", async () => {
    const error = await failure({ "[[a]].tsx": PAGE, "[[b]].tsx": PAGE });
    expect(error.issues.map((i) => i.code)).toEqual(["ROUTE_AMBIGUOUS"]);
  });

  it("[FRT-34b] two splats, or an optional folder and a plain route at the same place, conflict", async () => {
    const splats = await failure({ "files/[...rest].tsx": PAGE, "files/[...all].tsx": PAGE });
    expect(splats.issues.map((i) => i.code)).toEqual(["ROUTE_AMBIGUOUS"]);
    expect(splats.issues[0]?.files).toEqual(["files/[...all].tsx", "files/[...rest].tsx"]);
    const folders = await failure({ "[[a]]/x.tsx": PAGE, "[[b]]/x.tsx": PAGE });
    expect(folders.issues[0]?.code).toBe("ROUTE_AMBIGUOUS");
    const nested = await failure({ "docs/index.tsx": PAGE, "docs/[[page]].tsx": PAGE });
    expect(nested.issues[0]?.code).toBe("ROUTE_AMBIGUOUS");
    expect(nested.issues[0]?.path).toBe("/docs");
  });

  it("[FRT-34c] a splat next to an optional or a param is not a conflict: the matcher's priority decides", async () => {
    const result = await scan({
      "docs/[[page]].tsx": PAGE,
      "docs/[...rest].tsx": PAGE,
      "docs/[id]/edit.tsx": PAGE,
    });
    expect(result.entries.map((entry) => entry.id).sort()).toEqual([
      "/docs/*rest",
      "/docs/:id/edit",
      "/docs/:page?",
    ]);
  });

  it("[FRT-35] illegal param names, unmatched brackets and splats name the file", async () => {
    const error = await failure({
      "[1x].tsx": PAGE,
      "[oops.tsx": PAGE,
      "[...rest]/inner.tsx": PAGE,
      "ok.tsx": PAGE,
    });
    expect(error.issues.map((i) => [i.code, i.files[0]])).toEqual([
      ["ROUTE_BRACKET_UNMATCHED", "[oops.tsx"],
      ["ROUTE_PARAM_INVALID", "[1x].tsx"],
      ["ROUTE_SPLAT_NOT_LAST", "[...rest]/inner.tsx"],
    ]);
  });

  it("[FRT-36] a duplicated param name in one path is a pattern error", async () => {
    const error = await failure({ "[id]/[id].tsx": PAGE });
    expect(error.issues[0]?.code).toBe("ROUTE_PATTERN_INVALID");
    expect(error.issues[0]?.files).toEqual(["[id]/[id].tsx"]);
  });

  it("[FRT-37] page and API on the same path and method", async () => {
    const error = await failure({
      "posts.tsx": PAGE,
      "posts.ts": "export const GET = () => 1;",
      "other.tsx": PAGE,
      "other/index.ts": "export const HEAD = () => 1;",
    });
    expect(error.issues.map((i) => [i.code, i.files])).toEqual([
      ["ROUTE_PAGE_API_CONFLICT", ["other.tsx", "other/index.ts"]],
      ["ROUTE_PAGE_API_CONFLICT", ["posts.ts", "posts.tsx"]],
    ]);
  });

  it("[FRT-38] two API files for one path", async () => {
    const error = await failure({
      "api/x.ts": "export const GET = 1;",
      "api/x/index.ts": "export const POST = 1;",
    });
    expect(error.issues[0]?.code).toBe("ROUTE_DUPLICATE");
    expect(error.issues[0]?.files).toEqual(["api/x.ts", "api/x/index.ts"]);
  });

  it("[FRT-39] a file with a default component and method handlers", async () => {
    const error = await failure({ "x.tsx": `${PAGE}export const POST = () => 1;` });
    expect(error.issues[0]?.code).toBe("ROUTE_MIXED_EXPORTS");
  });

  it("[FRT-40] a script with nothing a route can use", async () => {
    const error = await failure({ "helpers.ts": "export const x = 1;" });
    expect(error.issues[0]?.code).toBe("ROUTE_NO_EXPORTS");
    expect(error.issues[0]?.message).toContain('leading "-"');
  });

  it("[FRT-41] syntax errors carry file, line and a code frame", async () => {
    const error = await failure({ "bad.tsx": "export default function () {\n  return <div>;\n}" });
    expect(error.issues[0]?.code).toBe("ROUTE_PARSE_ERROR");
    expect(error.issues[0]?.message).toContain("bad.tsx:");
    expect(error.issues[0]?.message).toContain("^");
  });

  it("[FRT-42] the server-function prefix is reserved", async () => {
    const error = await failure({ "_dusk/fn.tsx": PAGE, "_Dusk.tsx": PAGE });
    expect(error.issues.map((i) => i.code)).toEqual([
      "ROUTE_RESERVED_PREFIX",
      "ROUTE_RESERVED_PREFIX",
    ]);
    const allowed = await scan({ "_duskly.tsx": PAGE });
    expect(ids(allowed)).toEqual(["/_duskly"]);
  });

  it("[FRT-43] all problems are reported at once, sorted, with merged file lists", async () => {
    const error = await failure({
      "[a-b]/x.tsx": PAGE,
      "[a-b]/y.tsx": PAGE,
      "dup.tsx": PAGE,
      "dup/index.tsx": PAGE,
    });
    expect(error.issues.map((i) => i.code)).toEqual(["ROUTE_DUPLICATE", "ROUTE_PARAM_INVALID"]);
    expect(error.issues[1]?.files).toEqual(["[a-b]/x.tsx", "[a-b]/y.tsx"]);
  });

  it("[FRT-44] limits are enforced at the boundary", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) files[`r${index}.tsx`] = PAGE;
    expect(ids(await scan(files, { maxFiles: 5 }))).toHaveLength(5);
    const error = await failure(files, { maxFiles: 4 });
    expect(error.issues[0]?.code).toBe("ROUTE_LIMIT");
    const deep = { "a/b/c/index.tsx": PAGE };
    expect(ids(await scan(deep, { maxDepth: 3 }))).toEqual(["/a/b/c"]);
    expect((await failure(deep, { maxDepth: 2 })).issues[0]?.code).toBe("ROUTE_LIMIT");
  });
});

describe("scanRoutes: file system", () => {
  it("[FRT-50] symlinks inside the routes directory are followed, outside ones are ignored", async () => {
    const outside = makeTree({ "secret.tsx": "garbage(((", "shared/page.tsx": PAGE });
    trees.push(outside);
    const tree = makeTree({ "real/page.tsx": PAGE });
    trees.push(tree);
    symlinkSync(join(tree.root, "real"), join(tree.root, "alias"), "dir");
    symlinkSync(join(outside.root, "shared"), join(tree.root, "escape"), "dir");
    symlinkSync(join(outside.root, "secret.tsx"), join(tree.root, "leak.tsx"), "file");
    const result = await scanRoutes({ routesDir: tree.root });
    expect(ids(result)).toEqual(["/alias/page", "/real/page"]);
    const outsideIgnored = result.ignored
      .filter((item) => item.reason === "outside-root")
      .map((i) => i.file);
    expect(outsideIgnored).toEqual(["escape", "leak.tsx"]);
  });

  it("[FRT-51] a symlink loop terminates", async () => {
    const tree = makeTree({ "a/page.tsx": PAGE });
    trees.push(tree);
    symlinkSync(tree.root, join(tree.root, "a", "loop"), "dir");
    const result = await scanRoutes({ routesDir: tree.root });
    expect(ids(result)).toEqual(["/a/page"]);
    expect(result.ignored.map((item) => item.reason)).toContain("symlink-loop");
  });

  it("[FRT-52] a dangling symlink is ignored", async () => {
    const tree = makeTree({ "index.tsx": PAGE });
    trees.push(tree);
    symlinkSync(join(tree.root, "missing.tsx"), join(tree.root, "dangling.tsx"), "file");
    const result = await scanRoutes({ routesDir: tree.root });
    expect(ids(result)).toEqual(["/"]);
  });

  it("[FRT-53] unchanged files are not parsed again (cache by content)", async () => {
    const tree = makeTree({ "a.tsx": PAGE });
    trees.push(tree);
    const cache = new Map();
    await scanRoutes({ routesDir: tree.root, cache });
    expect(cache.size).toBe(1);
    writeFileSync(join(tree.root, "a.tsx"), `${PAGE}export const loader = () => 1;`);
    const result = await scanRoutes({ routesDir: tree.root, cache });
    expect(cache.size).toBe(2);
    expect(result.entries[0]?.info.exports).toContain("loader");
  });

  it("[FRT-54] a missing routes directory is an error from the file system", async () => {
    await expect(scanRoutes({ routesDir: join(makeTree({}).root, "nope") })).rejects.toThrow();
  });

  it("[FRT-55] scale: 2000 route files scan with identical order", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 2000; index += 1) {
      files[`g${index % 20}/r${index}.tsx`] = PAGE;
    }
    const first = await scan(files);
    expect(first.entries).toHaveLength(2000);
    const second = await scan(files);
    expect(second.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
    mkdirSync(join(first.routesDir, "unused"), { recursive: true });
  });
});
