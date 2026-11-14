import { describe, expect, it } from "vitest";
import { createMatcher, mapMatcher, type RouteDefinition } from "../../src/core/matcher";

/*
 * `mapMatcher`: the routes are matched against a path other than the one in the address bar (a host the server
 * rewrites to a private folder), while every other question about the location is asked as written.
 */

const tree: RouteDefinition[] = [
  {
    id: "root",
    children: [
      { id: "site-home", path: "/" },
      { id: "site-about", path: "/about" },
      {
        id: "dash",
        path: "/_hosts/dash",
        children: [
          { id: "dash-home", path: "/" },
          { id: "dash-about", path: "/about" },
          { id: "dash-item", path: "/items/:id" },
        ],
      },
    ],
  },
];

const intoDash = (path: string): string => (path === "/" ? "/_hosts/dash" : `/_hosts/dash${path}`);

describe("mapMatcher", () => {
  it("[RP-1] matches the mapped path and leaves the match chain, params and ids as the route tree has them", () => {
    const matcher = mapMatcher(createMatcher(tree), intoDash);
    expect(matcher.match("/").map((m) => m.id)).toEqual(["root", "dash", "dash-home"]);
    expect(matcher.match("/about").map((m) => m.id)).toEqual(["root", "dash", "dash-about"]);
    const item = matcher.match("/items/7");
    expect(item.map((m) => m.id)).toEqual(["root", "dash", "dash-item"]);
    expect(item.at(-1)?.params).toEqual({ id: "7" });
  });

  it("[RP-2] without a mapping the same paths reach the other host's routes", () => {
    const matcher = createMatcher(tree);
    expect(matcher.match("/").map((m) => m.id)).toEqual(["root", "site-home"]);
    expect(matcher.match("/about").map((m) => m.id)).toEqual(["root", "site-about"]);
  });

  it("[RP-3] the mapping sees the path without the base, and the match keeps the base", () => {
    const seen: string[] = [];
    const matcher = mapMatcher(createMatcher(tree, { basePath: "/app" }), (path) => {
      seen.push(path);
      return intoDash(path);
    });
    expect(matcher.match("/app/about").map((m) => m.id)).toEqual(["root", "dash", "dash-about"]);
    expect(seen).toEqual(["/about"]);
    expect(matcher.stripBase("/app/about")).toBe("/about");
    expect(matcher.addBase("/about")).toBe("/app/about");
    // Outside the base nothing matches, and the mapping is not asked.
    expect(matcher.match("/other/about")).toEqual([]);
    expect(seen).toEqual(["/about"]);
  });

  it("[RP-4] a private route stays private for a public match: the mapped path is not a way around the rule", () => {
    const matcher = mapMatcher(createMatcher(tree), intoDash);
    expect(matcher.match("/about", "public")).toEqual([]);
    expect(matcher.match("/about", "all").map((m) => m.id)).toEqual(["root", "dash", "dash-about"]);
  });

  it("[RP-5] a mapping that returns something that is not a path is no match, never a throw", () => {
    const bad = (value: unknown) =>
      mapMatcher(createMatcher(tree), () => value as string).match("/about");
    expect(bad("about")).toEqual([]);
    expect(bad(undefined)).toEqual([]);
    expect(bad("/%zz")).toEqual([]);
    expect(bad("")).toEqual([]);
  });

  it("[RP-6] the visible path is a different cache key from the mapped one: two mappings of one path never share an answer", () => {
    let host: "site" | "dash" = "site";
    const matcher = mapMatcher(createMatcher(tree), (path) =>
      host === "dash" ? intoDash(path) : path,
    );
    expect(matcher.match("/about").map((m) => m.id)).toEqual(["root", "site-about"]);
    host = "dash";
    expect(matcher.match("/about").map((m) => m.id)).toEqual(["root", "dash", "dash-about"]);
  });

  it("[RP-7] checkParams and cacheSize are the wrapped matcher's", () => {
    const inner = createMatcher(tree);
    const matcher = mapMatcher(inner, intoDash);
    matcher.match("/about");
    expect(matcher.cacheSize).toBe(inner.cacheSize);
    expect(matcher.checkParams("/items/:id", { id: "1" })).toBeUndefined();
  });
});
