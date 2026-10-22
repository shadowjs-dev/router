import { describe, expect, it } from "vitest";
import { parseRouteFile, patternOf, type RouteFileParse } from "../../src/vite/grammar";

function ok(path: string): { layout: boolean; pattern: string } {
  const parsed: RouteFileParse = parseRouteFile(path);
  if (parsed.status !== "ok")
    throw new Error(`expected ok for ${path}, got ${JSON.stringify(parsed)}`);
  const segments = parsed.leaf === undefined ? parsed.dirs : [...parsed.dirs, parsed.leaf];
  return { layout: parsed.layout, pattern: patternOf(segments) };
}

describe("route file grammar", () => {
  it.each([
    ["index.tsx", "/"],
    ["about.tsx", "/about"],
    ["posts/index.tsx", "/posts"],
    ["posts/[id].tsx", "/posts/:id"],
    ["posts/[id]/edit.tsx", "/posts/:id/edit"],
    ["[[lang]]/about.tsx", "/:lang?/about"],
    ["[[lang]].tsx", "/:lang?"],
    ["files/[...rest].tsx", "/files/*rest"],
    ["[...all].tsx", "/*all"],
    ["[[...slug]].tsx", "/*slug?"],
    ["docs/[[...slug]].tsx", "/docs/*slug?"],
    ["(marketing)/pricing.tsx", "/pricing"],
    ["(a)/(b)/x.tsx", "/x"],
    ["(auth)/index.tsx", "/"],
    ["sitemap.xml.tsx", "/sitemap.xml"],
    ["reindex.tsx", "/reindex"],
    ["a.b.c.ts", "/a.b.c"],
    ["[.]well-known/x.tsx", "/.well-known/x"],
    ["[-]x.tsx", "/-x"],
    ["[_]x.tsx", "/_x"],
    ["[(]x.tsx", "/(x"],
    ["café.tsx", "/café"],
    ["x́.tsx", "/x́".normalize("NFC")],
    ["日本語/ページ.tsx", "/日本語/ページ"],
    ["emoji-\u{1F600}.tsx", "/emoji-\u{1F600}"],
    ["a+b@c$d&e,f;g=h.tsx", "/a+b@c$d&e,f;g=h"],
  ])("[FRT-01] %s -> %s", (path, pattern) => {
    expect(ok(path).pattern).toBe(pattern);
  });

  it("[FRT-02] _layout files are layouts of their folder", () => {
    expect(ok("_layout.tsx")).toEqual({ layout: true, pattern: "/" });
    expect(ok("posts/_layout.tsx")).toEqual({ layout: true, pattern: "/posts" });
    expect(ok("(auth)/_layout.tsx")).toEqual({ layout: true, pattern: "/" });
  });

  it("[FRT-03] Windows separators and a leading ./ mean the same as POSIX", () => {
    expect(ok("posts\\[id].tsx").pattern).toBe("/posts/:id");
    expect(ok(".\\posts\\index.tsx").pattern).toBe("/posts");
    expect(ok("./about.tsx").pattern).toBe("/about");
    expect(ok("a\\(g)\\b\\_layout.tsx")).toEqual({ layout: true, pattern: "/a/b" });
  });

  it.each([
    ["-components/Button.tsx", "dash-prefix"],
    ["posts/-helpers.ts", "dash-prefix"],
    ["-x/[bad.tsx", "dash-prefix"],
    [".hidden.tsx", "dot-prefix"],
    ["posts/.DS_Store", "dot-prefix"],
    ["style.css", "extension"],
    ["README.md", "extension"],
    ["data.json", "extension"],
    ["types.d.ts", "declaration-file"],
    ["about.test.tsx", "test-file"],
    ["about.spec.ts", "test-file"],
    ["routeTree.gen.ts", "generated-file"],
    ["noext", "extension"],
  ])("[FRT-04] %s is ignored (%s)", (path, reason) => {
    expect(parseRouteFile(path)).toEqual({ status: "ignored", reason });
  });

  it.each([
    ["[id.tsx", "ROUTE_BRACKET_UNMATCHED"],
    ["id].tsx", "ROUTE_BRACKET_UNMATCHED"],
    ["[].tsx", "ROUTE_BRACKET_UNMATCHED"],
    ["[[]].tsx", "ROUTE_PARAM_INVALID"],
    ["[[[x]]].tsx", "ROUTE_PARAM_INVALID"],
    ["[1id].tsx", "ROUTE_PARAM_INVALID"],
    ["[a-b].tsx", "ROUTE_PARAM_INVALID"],
    ["[user id].tsx", "ROUTE_PARAM_INVALID"],
    ["[[...x]]/y.tsx", "ROUTE_SPLAT_NOT_LAST"],
    ["[...].tsx", "ROUTE_PARAM_INVALID"],
    ["[...a-b].tsx", "ROUTE_PARAM_INVALID"],
    ["post-[id].tsx", "ROUTE_BRACKET_UNMATCHED"],
    ["[...rest]/x.tsx", "ROUTE_SPLAT_NOT_LAST"],
    ["a b.tsx", "ROUTE_FILE_NAME_INVALID"],
    ["100%.tsx", "ROUTE_FILE_NAME_INVALID"],
    ["a\tb.tsx", "ROUTE_FILE_NAME_INVALID"],
    ["a#b.tsx", "ROUTE_FILE_NAME_INVALID"],
    [":id.tsx", "ROUTE_FILE_NAME_INVALID"],
    ["*.tsx", "ROUTE_FILE_NAME_INVALID"],
    ["(g).tsx", "ROUTE_GROUP_INVALID"],
    ["(a b)/x.tsx", "ROUTE_GROUP_INVALID"],
    ["((x))/y.tsx", "ROUTE_GROUP_INVALID"],
    ["a//b.tsx", "ROUTE_FILE_NAME_INVALID"],
    ["../x.tsx", "ROUTE_FILE_NAME_INVALID"],
    ["bad\ud800.tsx", "ROUTE_FILE_NAME_INVALID"],
  ])("[FRT-05] %s is invalid (%s)", (path, code) => {
    const parsed = parseRouteFile(path);
    expect(parsed.status).toBe("invalid");
    if (parsed.status === "invalid") {
      expect(parsed.code).toBe(code);
      expect(parsed.message.length).toBeGreaterThan(0);
    }
  });

  it("[FRT-06] a bracketed letter is a param, a bracketed digit is an illegal param name, punctuation is literal", () => {
    expect(ok("[a].tsx").pattern).toBe("/:a");
    expect(parseRouteFile("[7].tsx")).toMatchObject({
      status: "invalid",
      code: "ROUTE_PARAM_INVALID",
    });
    expect(ok("[~]x.tsx").pattern).toBe("/~x");
  });
});
