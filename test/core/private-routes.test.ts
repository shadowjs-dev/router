import { describe, expect, it } from "vitest";
import {
  comparePatterns,
  createMatcher,
  isPrivatePattern,
  type RouteDefinition,
} from "../../src/core/matcher";

/*
 * Private routes: a route whose URL pattern has a static segment that starts with "_" (a `_`-prefixed folder or
 * file, for example `_preview/[id]`) is internal. A request from outside (`visibility: "public"`) never matches it,
 * so it falls through to the next candidate or to not found. A rewrite target (`visibility: "all"`) matches it.
 */

const tree: RouteDefinition[] = [
  { id: "public-page", path: "/:section/:id" },
  { id: "private-preview", path: "/_preview/:id" },
  { id: "private-deep", path: "/_admin/tools/:name" },
];

describe("private routes in the matcher", () => {
  it("[PRIV-1] a pattern is private when one of its static segments starts with an underscore", () => {
    expect(isPrivatePattern("/_preview/:id")).toBe(true);
    expect(isPrivatePattern("/posts/_draft")).toBe(true);
    expect(isPrivatePattern("/_")).toBe(true);
    expect(isPrivatePattern("/f/:id/preview")).toBe(false);
    expect(isPrivatePattern("/a_b/:id")).toBe(false);
    expect(isPrivatePattern("/:_id")).toBe(false);
    expect(isPrivatePattern("/")).toBe(false);
  });

  it("[PRIV-2] a public match never returns a private route; the same path with visibility all does", () => {
    const matcher = createMatcher(tree);
    const outside = matcher.match("/_preview/7", "public");
    expect(outside.map((match) => match.id)).toEqual(["public-page"]);
    expect(outside[0]?.params).toEqual({ section: "_preview", id: "7" });
    const inside = matcher.match("/_preview/7", "all");
    expect(inside.map((match) => match.id)).toEqual(["private-preview"]);
    expect(inside[0]?.params).toEqual({ id: "7" });
  });

  it("[PRIV-3] the match cache keeps the two visibilities apart (the same path, asked both ways)", () => {
    const matcher = createMatcher(tree);
    expect(matcher.match("/_admin/tools/x", "all").map((m) => m.id)).toEqual(["private-deep"]);
    expect(matcher.match("/_admin/tools/x", "public").map((m) => m.id)).toEqual([]);
    expect(matcher.match("/_admin/tools/x", "all").map((m) => m.id)).toEqual(["private-deep"]);
    expect(matcher.match("/_admin/tools/x").map((m) => m.id)).toEqual(["private-deep"]);
  });

  it("[PRIV-4] a public path with no public route is not found; a private route keeps its filters", () => {
    const matcher = createMatcher(
      [{ id: "private-post", path: "/_drafts/:id", matchFilters: { id: /^\d+$/ } }],
      { compileFilter: () => (value) => value.length > 0 },
    );
    expect(matcher.match("/_drafts/3", "public")).toEqual([]);
    expect(matcher.match("/_drafts/3", "all").map((m) => m.id)).toEqual(["private-post"]);
  });

  it("[PRIV-5] the default visibility is all (the client router matches every route it was given)", () => {
    const matcher = createMatcher(tree);
    expect(matcher.match("/_preview/1").map((m) => m.id)).toEqual(["private-preview"]);
  });
});

describe("pattern specificity", () => {
  it("[PRE-1] a static segment is more specific than a param, a param than an optional, an optional than a splat", () => {
    expect(comparePatterns("/f/:id/preview", "/f/:id/:name")).toBeLessThan(0);
    expect(comparePatterns("/f/:id/:name", "/f/:id/:name")).toBe(0);
    expect(comparePatterns("/:id/x", "/:lang?/x")).toBeLessThan(0);
    expect(comparePatterns("/:lang?/x", "/*rest")).toBeLessThan(0);
    expect(comparePatterns("/a/*rest", "/a/:id")).toBeGreaterThan(0);
  });

  it("[PRE-2] the first differing segment decides, so a more specific prefix wins over a longer tail", () => {
    expect(comparePatterns("/a/:x/z", "/:y/b/c")).toBeLessThan(0);
    expect(comparePatterns("/a/b", "/a/:id")).toBeLessThan(0);
  });

  it("[PRE-3] the order agrees with the matcher: the route the matcher picks is never less specific than another that matches", () => {
    const routes: RouteDefinition[] = [
      { id: "param", path: "/f/:id/:name" },
      { id: "static", path: "/f/:id/preview" },
      { id: "splat", path: "/f/*rest" },
    ];
    const matcher = createMatcher(routes);
    expect(matcher.match("/f/1/preview").map((m) => m.id)).toEqual(["static"]);
    expect(matcher.match("/f/1/other").map((m) => m.id)).toEqual(["param"]);
    expect(matcher.match("/f/1/a/b").map((m) => m.id)).toEqual(["splat"]);
  });
});
