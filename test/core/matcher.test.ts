import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createMatcher,
  findConflicts,
  matchRoutes,
  type RouteDefinition,
  type RouteMatch,
} from "../../src/core/matcher";
import {
  buildPathFromParams,
  decodeSegment,
  encodeSegment,
  expandOptionals,
  type PatternSegment,
  parsePattern,
} from "../../src/core/path";

const PROPS = { seed: 5, numRuns: 300 } as const;

/** Plain-object copy of a match's params, for readable comparisons. */
function paramsOf(match: RouteMatch | undefined): Record<string, string> {
  return match === undefined ? {} : { ...match.params };
}

function idsOf(matches: readonly RouteMatch[]): string[] {
  return matches.map((match) => match.id);
}

/** Grapheme text without lone surrogates; never empty. */
const nonEmptyText = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 12 })
  .filter((text) => !hasLoneSurrogate(text));

function hasLoneSurrogate(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

describe("matchRoutes: priority", () => {
  it("[I-U7] a static segment beats a param, a param beats an optional, an optional beats a splat", () => {
    const tree: RouteDefinition[] = [
      { id: "splat", path: "x/*rest" },
      { id: "optional", path: "x/:v?" },
      { id: "param", path: "x/:v" },
      { id: "static", path: "x/y" },
    ];
    expect(idsOf(matchRoutes(tree, "/x/y"))).toEqual(["static"]);
    expect(idsOf(matchRoutes(tree, "/x/z"))).toEqual(["param"]);
    expect(idsOf(matchRoutes(tree.slice(0, 2), "/x/z"))).toEqual(["optional"]);
    expect(idsOf(matchRoutes(tree.slice(0, 1), "/x/z/w"))).toEqual(["splat"]);
  });

  it("[I-U7] among routes with identical structure, the first declared wins", () => {
    const tree: RouteDefinition[] = [
      { id: "first", path: "/u/:a" },
      { id: "second", path: "/u/:b" },
    ];
    expect(idsOf(matchRoutes(tree, "/u/1"))).toEqual(["first"]);
    expect(paramsOf(matchRoutes(tree, "/u/1")[0])).toEqual({ a: "1" });
  });

  it("[I-U7] a terminal match beats a splat that could also match the empty rest", () => {
    const tree: RouteDefinition[] = [
      { id: "splat", path: "/files/*rest" },
      { id: "exact", path: "/files" },
    ];
    expect(idsOf(matchRoutes(tree, "/files"))).toEqual(["exact"]);
    expect(idsOf(matchRoutes(tree, "/files/a"))).toEqual(["splat"]);
  });

  it("[I-U7] a static route at a deeper level beats a param at a shallower level", () => {
    const tree: RouteDefinition[] = [
      { id: "param-first", path: "/:a/b" },
      { id: "static-first", path: "/x/:b" },
    ];
    expect(idsOf(matchRoutes(tree, "/x/b"))).toEqual(["static-first"]);
  });
});

describe("matchRoutes: optionals and splats", () => {
  it("[I-U7] an optional param matches with and without its segment", () => {
    const tree: RouteDefinition[] = [{ id: "opt", path: "/posts/:lang?" }];
    expect(idsOf(matchRoutes(tree, "/posts"))).toEqual(["opt"]);
    expect(paramsOf(matchRoutes(tree, "/posts")[0])).toEqual({});
    expect(paramsOf(matchRoutes(tree, "/posts/fr")[0])).toEqual({ lang: "fr" });
  });

  it("[I-U8] a splat captures the rest of the path with its slashes", () => {
    const tree: RouteDefinition[] = [{ id: "files", path: "/files/*rest" }];
    expect(paramsOf(matchRoutes(tree, "/files/a/b/c")[0])).toEqual({ rest: "a/b/c" });
  });

  it("[A3-R3] a required splat does not match the path that ends at its prefix (it was an empty rest)", () => {
    const tree: RouteDefinition[] = [{ id: "files", path: "/files/*rest" }];
    expect(matchRoutes(tree, "/files")).toEqual([]);
    expect(matchRoutes(tree, "/files/")).toEqual([]);
  });

  it("[A3-R3] a bare required splat is keyed '*' and matches a non-empty path, not the root", () => {
    const tree: RouteDefinition[] = [{ id: "all", path: "/*" }];
    expect(matchRoutes(tree, "/")).toEqual([]);
    expect(paramsOf(matchRoutes(tree, "/a/b")[0])).toEqual({ "*": "a/b" });
  });

  it("[I-U8] the splat decodes each piece, so %20 becomes a space inside the rest", () => {
    const tree: RouteDefinition[] = [{ id: "files", path: "/files/*rest" }];
    expect(paramsOf(matchRoutes(tree, "/files/my%20doc/x")[0])).toEqual({ rest: "my doc/x" });
  });
});

describe("matchRoutes: URL handling", () => {
  it("[I-U1] an interior empty segment does not match the route without it", () => {
    const tree: RouteDefinition[] = [{ id: "ab", path: "/a/b" }];
    expect(matchRoutes(tree, "/a//b")).toEqual([]);
    expect(matchRoutes(tree, "/a/b")).toHaveLength(1);
  });

  it("[I-U1] a single trailing slash is tolerated", () => {
    const tree: RouteDefinition[] = [{ id: "ab", path: "/a/b" }];
    expect(idsOf(matchRoutes(tree, "/a/b/"))).toEqual(["ab"]);
  });

  it("[I-U2] a protocol-relative pathname never matches a route", () => {
    const tree: RouteDefinition[] = [{ id: "any", path: "/*" }];
    expect(matchRoutes(tree, "//evil.example")).toEqual([]);
  });

  it("[I-U3] a %2F inside a param stays inside one segment", () => {
    const tree: RouteDefinition[] = [{ id: "file", path: "/files/:name/edit" }];
    const matches = matchRoutes(tree, "/files/a%2Fb/edit");
    expect(idsOf(matches)).toEqual(["file"]);
    expect(paramsOf(matches[0])).toEqual({ name: "a/b" });
  });

  it("[I-U3] a malformed percent sequence never matches and never throws", () => {
    const tree: RouteDefinition[] = [
      { id: "param", path: "/a/:x" },
      { id: "splat", path: "/*" },
    ];
    expect(matchRoutes(tree, "/a/%zz")).toEqual([]);
    expect(matchRoutes(tree, "/%")).toEqual([]);
  });

  it("[I-U3] an encoded percent sign decodes once to a literal percent in a param", () => {
    const tree: RouteDefinition[] = [{ id: "p", path: "/p/:v" }];
    expect(paramsOf(matchRoutes(tree, "/p/50%25")[0])).toEqual({ v: "50%" });
    expect(paramsOf(matchRoutes(tree, "/p/%2541")[0])).toEqual({ v: "%41" });
  });

  it("[I-U3] an encoded backslash decodes to a backslash in a param", () => {
    const tree: RouteDefinition[] = [{ id: "p", path: "/p/:v" }];
    expect(paramsOf(matchRoutes(tree, "/p/a%5Cb")[0])).toEqual({ v: "a\\b" });
  });

  it("[I-U4] reserved-looking characters in a static segment match the raw pathname", () => {
    const tree: RouteDefinition[] = [{ id: "s", path: "/a+b@c:d$e&f,g;h=i" }];
    expect(idsOf(matchRoutes(tree, "/a+b@c:d$e&f,g;h=i"))).toEqual(["s"]);
    expect(idsOf(matchRoutes(tree, "/a+b@c:d$e&f,g;h=i/"))).toEqual(["s"]);
  });

  it("[I-U5] non-ASCII params decode from their UTF-8 escapes", () => {
    const tree: RouteDefinition[] = [{ id: "u", path: "/u/:name" }];
    expect(paramsOf(matchRoutes(tree, "/u/%E4%BD%A0")[0])).toEqual({ name: "你" });
    expect(paramsOf(matchRoutes(tree, "/u/你")[0])).toEqual({ name: "你" });
  });

  it("[I-U5] a non-ASCII static segment matches its escaped and raw forms", () => {
    const tree: RouteDefinition[] = [{ id: "cafe", path: "/café" }];
    expect(idsOf(matchRoutes(tree, "/caf%C3%A9"))).toEqual(["cafe"]);
    expect(idsOf(matchRoutes(tree, "/café"))).toEqual(["cafe"]);
  });

  it("[I-U6] static segments are case-insensitive by default", () => {
    const tree: RouteDefinition[] = [{ id: "about", path: "/About" }];
    expect(idsOf(matchRoutes(tree, "/ABOUT"))).toEqual(["about"]);
    expect(idsOf(matchRoutes(tree, "/about"))).toEqual(["about"]);
  });

  it("[I-U6] static segments are case-sensitive when the option says so", () => {
    const tree: RouteDefinition[] = [{ id: "about", path: "/About" }];
    const matcher = createMatcher(tree, { caseSensitive: true });
    expect(matcher.match("/ABOUT")).toEqual([]);
    expect(idsOf(matcher.match("/About"))).toEqual(["about"]);
  });

  it("[I-U6] params keep their case in both policies", () => {
    const tree: RouteDefinition[] = [{ id: "p", path: "/p/:Name" }];
    expect(paramsOf(matchRoutes(tree, "/P/AbC")[0])).toEqual({ Name: "AbC" });
  });
});

describe("matchRoutes: nested trees", () => {
  const tree: RouteDefinition[] = [
    {
      id: "root",
      path: "",
      children: [
        { id: "home", path: "" },
        {
          id: "users",
          path: "users",
          children: [
            { id: "users-index", path: "" },
            {
              id: "user",
              path: ":id",
              children: [{ id: "profile", path: "profile" }],
            },
          ],
        },
        { id: "files", path: "files/*rest" },
      ],
    },
  ];

  it("returns the root-to-leaf chain for the root page", () => {
    const matches = matchRoutes(tree, "/");
    expect(idsOf(matches)).toEqual(["root", "home"]);
    expect(matches.map((match) => match.depth)).toEqual([0, 1]);
  });

  it("returns the chain of an index child", () => {
    expect(idsOf(matchRoutes(tree, "/users"))).toEqual(["root", "users", "users-index"]);
  });

  it("does not match a non-leaf route on its own", () => {
    expect(matchRoutes(tree, "/users/5")).toEqual([]);
  });

  it("accumulates params per match: a parent only sees params from its own depth", () => {
    const matches = matchRoutes(tree, "/users/5/profile");
    expect(idsOf(matches)).toEqual(["root", "users", "user", "profile"]);
    expect(matches.map((match) => paramsOf(match))).toEqual([{}, {}, { id: "5" }, { id: "5" }]);
  });

  it("captures a splat inside a nested child", () => {
    const matches = matchRoutes(tree, "/files/x/y");
    expect(idsOf(matches)).toEqual(["root", "files"]);
    expect(paramsOf(matches[1])).toEqual({ rest: "x/y" });
  });

  it("a pathless layout contributes a chain entry and no path segments", () => {
    const layout: RouteDefinition[] = [{ id: "layout", children: [{ id: "a", path: "a" }] }];
    expect(idsOf(matchRoutes(layout, "/a"))).toEqual(["layout", "a"]);
    expect(matchRoutes(layout, "/")).toEqual([]);
  });

  it("a pathless leaf matches the same path as its parent", () => {
    const pathless: RouteDefinition[] = [{ id: "p", path: "/x", children: [{ id: "leaf" }] }];
    expect(idsOf(matchRoutes(pathless, "/x"))).toEqual(["p", "leaf"]);
  });

  it("[I-U7] children with optional params expand under their parent", () => {
    const optionalTree: RouteDefinition[] = [
      {
        id: "shop",
        path: "shop",
        children: [{ id: "item", path: ":cat?/:sku" }],
      },
    ];
    expect(paramsOf(matchRoutes(optionalTree, "/shop/a")[1])).toEqual({ sku: "a" });
    expect(paramsOf(matchRoutes(optionalTree, "/shop/a/b")[1])).toEqual({ cat: "a", sku: "b" });
  });
});

describe("createMatcher: base path", () => {
  const tree: RouteDefinition[] = [
    { id: "home", path: "/" },
    { id: "users", path: "/users/:id" },
  ];
  const matcher = createMatcher(tree, { basePath: "/app" });

  it("[I-U9] matches only below the base path", () => {
    expect(idsOf(matcher.match("/app/users/3"))).toEqual(["users"]);
    expect(idsOf(matcher.match("/app"))).toEqual(["home"]);
    expect(idsOf(matcher.match("/app/"))).toEqual(["home"]);
  });

  it("[I-U9] '/app' does not claim '/application'", () => {
    expect(matcher.match("/application/users/3")).toEqual([]);
    expect(matcher.match("/application")).toEqual([]);
  });

  it("[I-U9] a pathname outside the base path does not match", () => {
    expect(matcher.match("/users/3")).toEqual([]);
  });

  it("[I-U9] stripBase and addBase are inverse for paths below the base", () => {
    expect(matcher.stripBase("/app/x/y")).toBe("/x/y");
    expect(matcher.stripBase("/app")).toBe("/");
    expect(matcher.addBase("/x/y")).toBe("/app/x/y");
    expect(matcher.addBase("/")).toBe("/app");
    expect(matcher.stripBase("/application")).toBeUndefined();
  });

  it("[I-U9] an empty or root base path changes nothing", () => {
    const rootMatcher = createMatcher(tree, { basePath: "/" });
    expect(idsOf(rootMatcher.match("/users/1"))).toEqual(["users"]);
    expect(rootMatcher.addBase("/x")).toBe("/x");
  });

  it("[I-U9] a base path with a trailing slash behaves like one without", () => {
    const slashMatcher = createMatcher(tree, { basePath: "/app/" });
    expect(idsOf(slashMatcher.match("/app/users/3"))).toEqual(["users"]);
  });
});

describe("createMatcher: caching", () => {
  it("[I-L5] the match cache is bounded at 1000 entries", () => {
    const matcher = createMatcher([{ id: "any", path: "/*" }]);
    for (let index = 0; index < 5000; index += 1) {
      matcher.match(`/item/${index}`);
    }
    expect(matcher.cacheSize).toBeLessThanOrEqual(1000);
    expect(matcher.cacheSize).toBeGreaterThan(0);
  });

  it("returns the same frozen result for a repeated pathname from the cache", () => {
    const matcher = createMatcher([{ id: "p", path: "/p/:v" }]);
    const first = matcher.match("/p/1");
    expect(matcher.match("/p/1")).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("[I-L5] a hot pathname stays cached through a long scan of other pathnames", () => {
    const matcher = createMatcher([{ id: "p", path: "/p/:v" }]);
    const hot = matcher.match("/p/hot");
    for (let index = 0; index < 3000; index += 1) {
      matcher.match("/p/hot");
      matcher.match(`/p/cold${index}`);
    }
    expect(matcher.match("/p/hot")).toBe(hot);
  });
});

describe("findConflicts", () => {
  it("[I-U14] reports two routes with the same structure as ambiguous", () => {
    const conflicts = findConflicts([
      { id: "a", path: "/x/:id" },
      { id: "b", path: "/x/:name" },
    ]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "ambiguous-path", ids: ["a", "b"] }),
    ]);
  });

  it("[I-U14] reports duplicate route ids", () => {
    const conflicts = findConflicts([
      { id: "dup", path: "x" },
      { id: "dup", path: "y" },
    ]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "duplicate-id", ids: ["dup", "dup"] }),
    ]);
  });

  it("[I-U14] finds no conflict for distinct routes", () => {
    expect(
      findConflicts([
        { id: "a", path: "x" },
        { id: "b", path: "x/:id" },
        { id: "c", path: "x/*rest" },
      ]),
    ).toEqual([]);
  });

  it("treats static segments differing only in case as the same path by default", () => {
    expect(
      findConflicts([
        { id: "a", path: "/About" },
        { id: "b", path: "/about" },
      ]),
    ).toHaveLength(1);
    expect(
      findConflicts(
        [
          { id: "a", path: "/About" },
          { id: "b", path: "/about" },
        ],
        { caseSensitive: true },
      ),
    ).toEqual([]);
  });

  it("an optional segment conflicts with an explicit route for its absent variant", () => {
    expect(
      findConflicts([
        { id: "opt", path: "/x/:id?" },
        { id: "bare", path: "/x" },
      ]),
    ).toEqual([expect.objectContaining({ kind: "ambiguous-path", ids: ["opt", "bare"] })]);
  });

  it("a non-leaf route is not an endpoint, so its own path does not conflict", () => {
    expect(
      findConflicts([
        { id: "parent", path: "x", children: [{ id: "index", path: "" }] },
        { id: "other", path: "y" },
      ]),
    ).toEqual([]);
  });

  it("a child index conflicts with a sibling route at the same path", () => {
    expect(
      findConflicts([
        { id: "parent", path: "x", children: [{ id: "index", path: "" }] },
        { id: "other", path: "x" },
      ]),
    ).toEqual([expect.objectContaining({ kind: "ambiguous-path", ids: ["index", "other"] })]);
  });
});

/**
 * Naive reference matcher. For each route it enumerates the variants and checks them against the
 * path segment by segment, recording the rank of each consumed segment. The winner is the
 * lexicographically smallest rank sequence, then the earliest route, then the earliest variant.
 * Rank: static 0 < param 1 < optional 2 < splat 3.
 */
interface RefPath {
  readonly canon: string;
  readonly value: string;
}

interface RefCandidate {
  readonly ranks: readonly number[];
  readonly route: number;
  readonly variant: number;
  readonly params: Record<string, string>;
}

const RANK: Record<PatternSegment["kind"], number> = {
  static: 0,
  param: 1,
  optional: 2,
  splat: 3,
};

function refVariant(
  variant: readonly PatternSegment[],
  path: readonly RefPath[],
): { ranks: number[]; params: Record<string, string> } | undefined {
  const ranks: number[] = [];
  const params: Record<string, string> = {};
  let position = 0;
  for (const segment of variant) {
    if (segment.kind === "static") {
      const current = path[position];
      if (
        current === undefined ||
        current.canon.toLowerCase() !== segment.canonical.toLowerCase()
      ) {
        return undefined;
      }
      ranks.push(RANK.static);
      position += 1;
    } else if (segment.kind === "param" || segment.kind === "optional") {
      const current = path[position];
      if (current === undefined) return undefined;
      ranks.push(RANK[segment.kind]);
      params[segment.name] = current.value;
      position += 1;
    } else {
      // [A3-R3] a required splat needs at least one segment (it never matches its own folder root).
      if (position >= path.length) return undefined;
      const rest = path.slice(position).map((piece) => piece.value);
      ranks.push(RANK.splat);
      params[segment.name] = rest.join("/");
      position = path.length;
    }
  }
  if (position !== path.length) return undefined;
  return { ranks, params };
}

function compareRanks(left: readonly number[], right: readonly number[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function naiveMatch(
  routes: readonly { id: string; path: string }[],
  path: readonly RefPath[],
): { id: string; params: Record<string, string> } | undefined {
  let best: RefCandidate | undefined;
  for (const [routeIndex, route] of routes.entries()) {
    const variants = expandOptionals(parsePattern(route.path).segments);
    for (const [variantIndex, variant] of variants.entries()) {
      const matched = refVariant(variant, path);
      if (matched === undefined) continue;
      const candidate: RefCandidate = {
        ranks: matched.ranks,
        route: routeIndex,
        variant: variantIndex,
        params: matched.params,
      };
      if (best === undefined) {
        best = candidate;
        continue;
      }
      const order =
        compareRanks(candidate.ranks, best.ranks) ||
        candidate.route - best.route ||
        candidate.variant - best.variant;
      if (order < 0) best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const route = routes[best.route];
  if (route === undefined) return undefined;
  return { id: route.id, params: best.params };
}

/** Random flat route sets built from a small vocabulary, so that collisions happen often. */
const segmentChoice = fc.constantFrom("a", "b", "A", "p", "o", "*");
const routeSpec = fc.array(segmentChoice, { minLength: 0, maxLength: 3 }).map((choices) => {
  const parts = choices.map((choice, index) => {
    if (choice === "p") return `:p${index}`;
    if (choice === "o") return `:o${index}?`;
    if (choice === "*") return `*s${index}`;
    return choice;
  });
  const withoutSplatMiddle = parts.map((part, index) =>
    part.startsWith("*") && index !== parts.length - 1 ? `:x${index}` : part,
  );
  return `/${withoutSplatMiddle.join("/")}`;
});
const pathSegment = fc.constantFrom("a", "b", "A", "c", "%61", "%41");
const pathSpec = fc.array(pathSegment, { minLength: 0, maxLength: 4 });

describe("matchRoutes: differential against a naive reference", () => {
  it("[I-U7] agrees with the naive matcher on random route sets and paths", () => {
    let hits = 0;
    fc.assert(
      fc.property(
        fc.array(routeSpec, { minLength: 1, maxLength: 5 }),
        pathSpec,
        (patterns, pieces) => {
          const routes = patterns.map((path, index) => ({ id: `r${index}`, path }));
          const tree: RouteDefinition[] = routes.map((route) => ({
            id: route.id,
            path: route.path,
          }));
          const rawPath = `/${pieces.join("/")}`;
          const refPath: RefPath[] = pieces.map((raw) => {
            const value = decodeSegment(raw) ?? "";
            return { canon: encodeSegment(value), value };
          });

          const expected = naiveMatch(routes, refPath);
          const actual = matchRoutes(tree, rawPath);
          if (expected === undefined) {
            expect(actual).toEqual([]);
          } else {
            hits += 1;
            expect(idsOf(actual)).toEqual([expected.id]);
            expect(paramsOf(actual[0])).toEqual(expected.params);
          }
        },
      ),
      PROPS,
    );
    // Guards against a vacuous comparison: a healthy share of cases must actually match.
    expect(hits).toBeGreaterThan(PROPS.numRuns / 4);
  });

  it("[I-U7] the matcher is deterministic: a fresh matcher returns the same result", () => {
    fc.assert(
      fc.property(
        fc.array(routeSpec, { minLength: 1, maxLength: 5 }),
        pathSpec,
        (patterns, pieces) => {
          const tree: RouteDefinition[] = patterns.map((path, index) => ({
            id: `r${index}`,
            path,
          }));
          const path = `/${pieces.join("/")}`;
          const first = createMatcher(tree).match(path);
          const second = createMatcher(tree).match(path);
          expect(idsOf(first)).toEqual(idsOf(second));
          expect(first.map((match) => paramsOf(match))).toEqual(
            second.map((match) => paramsOf(match)),
          );
        },
      ),
      PROPS,
    );
  });
});

describe("matchRoutes: round trip with buildPath", () => {
  it("match(build(pattern, params)) returns the params for any unicode required param", () => {
    fc.assert(
      fc.property(nonEmptyText, (value) => {
        const tree: RouteDefinition[] = [{ id: "user", path: "/users/:id/details" }];
        const built = buildPathFromParams("/users/:id/details", { id: value });
        const matches = matchRoutes(tree, built);
        expect(idsOf(matches)).toEqual(["user"]);
        expect(paramsOf(matches[0])).toEqual({ id: value });
      }),
      PROPS,
    );
  });

  it("match(build(pattern, params)) returns the splat for any non-empty pieces", () => {
    const piece = nonEmptyText.filter((text) => !text.includes("/"));
    fc.assert(
      fc.property(fc.array(piece, { minLength: 1, maxLength: 4 }), (pieces) => {
        const rest = pieces.join("/");
        const tree: RouteDefinition[] = [{ id: "files", path: "/files/*rest" }];
        const built = buildPathFromParams("/files/*rest", { rest });
        expect(paramsOf(matchRoutes(tree, built)[0])).toEqual({ rest });
      }),
      PROPS,
    );
  });

  it("[P-12] round trip holds for optional params given left to right", () => {
    fc.assert(
      fc.property(fc.option(nonEmptyText, { nil: undefined }), nonEmptyText, (lang, slug) => {
        const tree: RouteDefinition[] = [{ id: "post", path: "/:lang?/posts/:slug" }];
        const params: Record<string, string | undefined> =
          lang === undefined ? { slug } : { lang, slug };
        const built = buildPathFromParams("/:lang?/posts/:slug", params);
        const matches = matchRoutes(tree, built);
        expect(idsOf(matches)).toEqual(["post"]);
        expect(paramsOf(matches[0])).toEqual(lang === undefined ? { slug } : { lang, slug });
      }),
      PROPS,
    );
  });

  it("[I-U5] a non-ASCII static pattern segment round trips through the matcher", () => {
    const tree: RouteDefinition[] = [{ id: "cjk", path: "/你好/:v" }];
    const built = buildPathFromParams("/你好/:v", { v: "x" });
    expect(built).toBe(`/${encodeSegment("你好")}/x`);
    expect(idsOf(matchRoutes(tree, built))).toEqual(["cjk"]);
  });
});

describe("expandOptionals and the matcher agree on variant shapes", () => {
  it("[P-8] a pattern with no optionals matches exactly one variant", () => {
    expect(expandOptionals(parsePattern("/a/:b").segments)).toHaveLength(1);
  });
});
