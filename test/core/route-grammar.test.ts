import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createMatcher,
  matchRoutes,
  type RouteDefinition,
  type RouteMatch,
} from "../../src/core/matcher";
import {
  buildPathFromParams,
  type ParamsOf,
  PatternSyntaxError,
  parsePattern,
} from "../../src/core/path";

import { compileMatchFilter } from "../support/features";

/** The matchFilters compiler: the matchers below build routes that declare filters. */
const FILTERS = { compileFilter: compileMatchFilter };

/**
 * Route grammar of the core matcher: the optional catch-all `*name?`, required splats that never
 * match their own folder root, the precedence table (static > param > optional > splat, then
 * declaration order), `matchFilters` (a failing value falls through to the next candidate), and a
 * property test against a brute-force reference that shares no code with the trie.
 */

const PROPS = { seed: 7, numRuns: 400 } as const;

function idsOf(matches: readonly RouteMatch[]): string[] {
  return matches.map((match) => match.id);
}

function paramsOf(match: RouteMatch | undefined): Record<string, string> {
  return match === undefined ? {} : { ...match.params };
}

describe("route grammar: typed params", () => {
  it("[A3-R4] a required param is a string; an optional one, and an optional catch-all, may be absent", () => {
    expectTypeOf<ParamsOf<"/posts/:id">>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<ParamsOf<"/posts/:lang?">>().toEqualTypeOf<{ lang?: string }>();
    expectTypeOf<ParamsOf<"/docs/*rest">>().toEqualTypeOf<{ rest: string }>();
    expectTypeOf<ParamsOf<"/docs/*rest?">>().toEqualTypeOf<{ rest?: string }>();
  });
});

describe("route grammar: optional catch-all and required splat", () => {
  it("[A3-R1] parsePattern reads an optional splat, bare or named, as the last segment", () => {
    expect(parsePattern("/docs/*rest?").segments).toEqual([
      { kind: "static", text: "docs", canonical: "docs" },
      { kind: "splat", name: "rest", optional: true },
    ]);
    expect(parsePattern("/*?").segments).toEqual([{ kind: "splat", name: "*", optional: true }]);
  });

  it("[A3-R1] an optional splat that is not last is a pattern error", () => {
    expect(() => parsePattern("/*rest?/tail")).toThrow(PatternSyntaxError);
  });

  it("[A3-R2] an optional catch-all matches its folder root and every deeper path", () => {
    const tree: RouteDefinition[] = [{ id: "docs", path: "/docs/*rest?" }];
    expect(idsOf(matchRoutes(tree, "/docs", FILTERS))).toEqual(["docs"]);
    expect(paramsOf(matchRoutes(tree, "/docs", FILTERS)[0])).toEqual({});
    expect(paramsOf(matchRoutes(tree, "/docs/a/b", FILTERS)[0])).toEqual({ rest: "a/b" });
    expect(matchRoutes(tree, "/other", FILTERS)).toEqual([]);
  });

  it("[A3-R3] a required splat does not match its own folder root, with or without a trailing slash", () => {
    const tree: RouteDefinition[] = [{ id: "files", path: "/files/*rest" }];
    expect(matchRoutes(tree, "/files", FILTERS)).toEqual([]);
    expect(matchRoutes(tree, "/files/", FILTERS)).toEqual([]);
    expect(paramsOf(matchRoutes(tree, "/files/a", FILTERS)[0])).toEqual({ rest: "a" });
  });

  it("[A3-R3] a bare required splat does not match the root, a bare optional one does", () => {
    expect(matchRoutes([{ id: "all", path: "/*" }], "/", FILTERS)).toEqual([]);
    expect(idsOf(matchRoutes([{ id: "all", path: "/*?" }], "/", FILTERS))).toEqual(["all"]);
    expect(paramsOf(matchRoutes([{ id: "all", path: "/*?" }], "/", FILTERS)[0])).toEqual({});
  });

  it("[A3-R4] buildPathFromParams: a required splat must have a value; an optional one may be absent", () => {
    expect(() => buildPathFromParams("/files/*rest", { rest: "" })).toThrow(RangeError);
    expect(() => buildPathFromParams("/files/*rest", {})).toThrow(RangeError);
    expect(buildPathFromParams("/docs/*rest?", {})).toBe("/docs");
    expect(buildPathFromParams("/docs/*rest?", { rest: "" })).toBe("/docs");
    expect(buildPathFromParams("/docs/*rest?", { rest: "a/b c" })).toBe("/docs/a/b%20c");
  });
});

describe("route grammar: precedence table", () => {
  it.each<[string, RouteDefinition[], string, string]>([
    [
      "a static segment beats a param",
      [
        { id: "param", path: "/x/:v" },
        { id: "static", path: "/x/y" },
      ],
      "/x/y",
      "static",
    ],
    [
      "a param beats an optional param",
      [
        { id: "optional", path: "/x/:v?" },
        { id: "param", path: "/x/:v" },
      ],
      "/x/z",
      "param",
    ],
    [
      "an optional param beats an optional catch-all",
      [
        { id: "optional-splat", path: "/x/*rest?" },
        { id: "optional", path: "/x/:v?" },
      ],
      "/x/z",
      "optional",
    ],
    [
      "a required catch-all and an optional catch-all of one shape tie: the first declared wins (the scanner rejects the pair)",
      [
        { id: "optional-splat", path: "/x/*rest?" },
        { id: "splat", path: "/x/*rest" },
      ],
      "/x/z/w",
      "optional-splat",
    ],
    [
      "an optional catch-all matches the folder root where a required splat cannot, even when declared later",
      [
        { id: "splat", path: "/x/*rest" },
        { id: "optional-splat", path: "/x/*rest?" },
      ],
      "/x",
      "optional-splat",
    ],
    [
      "an optional param beats a required splat at the same depth",
      [
        { id: "splat", path: "/x/*rest" },
        { id: "optional", path: "/x/:v?" },
      ],
      "/x/z",
      "optional",
    ],
    [
      "a static segment at a deeper level beats a param at a shallower level",
      [
        { id: "param-first", path: "/:a/b" },
        { id: "static-first", path: "/x/:b" },
      ],
      "/x/b",
      "static-first",
    ],
    [
      "of two routes that match the same path, the one declared first wins (exact before optional catch-all)",
      [
        { id: "exact", path: "/x" },
        { id: "optional-splat", path: "/x/*r?" },
      ],
      "/x",
      "exact",
    ],
    [
      "and the optional catch-all wins when it is declared first",
      [
        { id: "optional-splat", path: "/x/*r?" },
        { id: "exact", path: "/x" },
      ],
      "/x",
      "optional-splat",
    ],
  ])("[A3-R5] %s", (_label, tree, path, winner) => {
    expect(matchRoutes(tree, path, FILTERS)[0]?.id).toBe(winner);
  });
});

/**
 * A segment of a generated tree. One flat shape: `text` for statics, `name` (unique in the tree)
 * for params and splats, `optional` for `?` forms, `filtered` for a matchFilters rule that rejects
 * the value `c`.
 */
interface SegSpec {
  readonly kind: "static" | "param" | "splat";
  readonly text: "a" | "b" | "";
  readonly name: string;
  readonly optional: boolean;
  readonly filtered: boolean;
}

interface NodeSpec {
  readonly segs: readonly SegSpec[];
  readonly children: readonly NodeSpec[];
}

/** Fails for the value `c`, so a generated path can fall through to the next candidate. */
const rejectsC = (value: string): boolean => value !== "c";

function renderSeg(seg: SegSpec): string {
  if (seg.kind === "static") return seg.text;
  const mark = seg.optional ? "?" : "";
  return seg.kind === "param" ? `:${seg.name}${mark}` : `*${seg.name}${mark}`;
}

/** The route definitions the matcher takes; ids are `r<preorder index>`. */
function toDefinitions(
  nodes: readonly NodeSpec[],
  top: boolean,
  counter: { next: number },
): RouteDefinition[] {
  return nodes.map((node): RouteDefinition => {
    const id = `r${counter.next}`;
    counter.next += 1;
    const path = `${top ? "/" : ""}${node.segs.map(renderSeg).join("/")}`;
    const matchFilters: Record<string, (value: string) => boolean> = {};
    for (const seg of node.segs) {
      if (seg.kind !== "static" && seg.filtered) matchFilters[seg.name] = rejectsC;
    }
    const children = toDefinitions(node.children, false, counter);
    return {
      id,
      path,
      ...(Object.keys(matchFilters).length === 0 ? {} : { matchFilters }),
      ...(children.length === 0 ? {} : { children }),
    };
  });
}

/** One matcher piece of a variant: a static text, or a param, optional param or splat. */
type Piece =
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "param"; readonly name: string; readonly filtered: boolean }
  | { readonly kind: "optional"; readonly name: string; readonly filtered: boolean }
  | { readonly kind: "splat"; readonly name: string; readonly filtered: boolean };

/** Every variant of one node's own segments: present before absent, first segment most significant. */
function variantsOf(segs: readonly SegSpec[], from = 0): Piece[][] {
  const seg = segs[from];
  if (seg === undefined) return [[]];
  const tail = variantsOf(segs, from + 1);
  const out: Piece[][] = [];
  if (seg.kind === "static") {
    for (const rest of tail) out.push([{ kind: "static", text: seg.text }, ...rest]);
    return out;
  }
  const present: Piece =
    seg.kind === "param"
      ? { kind: seg.optional ? "optional" : "param", name: seg.name, filtered: seg.filtered }
      : { kind: "splat", name: seg.name, filtered: seg.filtered };
  for (const rest of tail) out.push([present, ...rest]);
  if (seg.optional) for (const rest of tail) out.push([...rest]);
  return out;
}

/** Structure of a chain, ignoring names: the matcher drops a variant whose structure it has seen. */
function structureKey(pieces: readonly Piece[]): string {
  return pieces
    .map((piece) =>
      piece.kind === "static"
        ? `s${piece.text}`
        : piece.kind === "param"
          ? "p"
          : piece.kind === "optional"
            ? "o"
            : "a",
    )
    .join("|");
}

interface LeafChains {
  readonly id: string;
  readonly chains: readonly (readonly Piece[])[];
}

/**
 * Every leaf and its chains, in declaration order. A node's variants are combined with the variants
 * of its ancestors (ancestors first), and a structure seen before is dropped, as the matcher does.
 */
function leafChains(tree: readonly NodeSpec[]): LeafChains[] {
  const out: LeafChains[] = [];
  let order = 0;
  const walk = (nodes: readonly NodeSpec[], prefixes: readonly (readonly Piece[])[]): void => {
    for (const node of nodes) {
      const index = order;
      order += 1;
      const own = variantsOf(node.segs);
      const product: Piece[][] = [];
      const seen = new Set<string>();
      for (const base of prefixes) {
        for (const variant of own) {
          const pieces = [...base, ...variant];
          const key = structureKey(pieces);
          if (seen.has(key)) continue;
          seen.add(key);
          product.push(pieces);
        }
      }
      if (node.children.length === 0) out.push({ id: `r${index}`, chains: product });
      else walk(node.children, product);
    }
  };
  walk(tree, [[]]);
  return out;
}

/**
 * Matches one chain against decoded segments. Returns the priority codes per path position (static
 * 0, param 1, optional param 2, splat 3, which ends the sequence) and the params, or undefined.
 */
function matchChain(
  pieces: readonly Piece[],
  segs: readonly string[],
): { codes: number[]; params: Record<string, string> } | undefined {
  const codes: number[] = [];
  const params: Record<string, string> = {};
  let at = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece === undefined) return undefined;
    if (piece.kind === "splat") {
      if (index !== pieces.length - 1 || at >= segs.length) return undefined;
      const rest = segs.slice(at).join("/");
      if (piece.filtered && !rejectsC(rest)) return undefined;
      codes.push(3);
      params[piece.name] = rest;
      return { codes, params };
    }
    if (at >= segs.length) return undefined;
    const value = segs[at] ?? "";
    if (piece.kind === "static") {
      if (value !== piece.text) return undefined;
      codes.push(0);
    } else {
      if (piece.filtered && !rejectsC(value)) return undefined;
      codes.push(piece.kind === "param" ? 1 : 2);
      params[piece.name] = value;
    }
    at += 1;
  }
  return at === segs.length ? { codes, params } : undefined;
}

function compareCodes(a: readonly number[], b: readonly number[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

/** The brute-force answer: the matching chain with the smallest priority, earliest declared first. */
function reference(
  leaves: readonly LeafChains[],
  segs: readonly string[],
): { id: string; params: Record<string, string> } | undefined {
  let best: { id: string; codes: number[]; params: Record<string, string> } | undefined;
  for (const leaf of leaves) {
    for (const pieces of leaf.chains) {
      const found = matchChain(pieces, segs);
      if (found === undefined) continue;
      if (best === undefined || compareCodes(found.codes, best.codes) < 0) {
        best = { id: leaf.id, codes: found.codes, params: found.params };
      }
    }
  }
  return best === undefined ? undefined : { id: best.id, params: best.params };
}

function pathOf(segs: readonly string[]): string {
  return segs.length === 0 ? "/" : `/${segs.join("/")}`;
}

/** Compares the matcher with the reference; returns whether the path matched at all. */
function compareWithReference(tree: readonly NodeSpec[], segs: readonly string[]): boolean {
  const definitions = toDefinitions(tree, true, { next: 0 });
  const expected = reference(leafChains(tree), segs);
  const actual = createMatcher(definitions, FILTERS).match(pathOf(segs));
  if (expected === undefined) {
    expect(actual).toEqual([]);
    return false;
  }
  const leaf = actual[actual.length - 1];
  expect(leaf?.id).toBe(expected.id);
  expect({ ...(leaf?.params ?? {}) }).toEqual(expected.params);
  return true;
}

/** A generated segment list for a node; names are assigned later so each tree's names are unique. */
interface Shape {
  readonly segs: readonly Omit<SegSpec, "name">[];
  readonly children: readonly Shape[];
  readonly splat: Omit<SegSpec, "name"> | undefined;
}

const plainSeg: fc.Arbitrary<Omit<SegSpec, "name">> = fc.oneof(
  fc.record({
    kind: fc.constant("static" as const),
    text: fc.constantFrom("a" as const, "b" as const),
    optional: fc.constant(false),
    filtered: fc.constant(false),
  }),
  fc.record({
    kind: fc.constant("param" as const),
    text: fc.constant("" as const),
    optional: fc.boolean(),
    filtered: fc.boolean(),
  }),
);

const splatSeg: fc.Arbitrary<Omit<SegSpec, "name">> = fc.record({
  kind: fc.constant("splat" as const),
  text: fc.constant("" as const),
  optional: fc.boolean(),
  filtered: fc.boolean(),
});

function shapeArb(depth: number): fc.Arbitrary<Shape> {
  const leaf = fc
    .tuple(fc.array(plainSeg, { maxLength: 2 }), fc.option(splatSeg, { nil: undefined }))
    .map(([segs, splat]) => ({ segs, children: [], splat }));
  if (depth >= 2) return leaf;
  const branch = fc
    .tuple(
      fc.array(plainSeg, { maxLength: 2 }),
      fc.array(shapeArb(depth + 1), { minLength: 1, maxLength: 2 }),
    )
    .map(([segs, children]) => ({ segs, children, splat: undefined }));
  return fc.oneof(leaf, branch);
}

/** Assigns unique param names in preorder and places a leaf's splat last. */
function materialize(shapes: readonly Shape[], counter: { next: number }): NodeSpec[] {
  const name = (seg: Omit<SegSpec, "name">): SegSpec => {
    const named = seg.kind === "static" ? "" : `p${counter.next}`;
    if (seg.kind !== "static") counter.next += 1;
    return { ...seg, name: named };
  };
  return shapes.map((shape): NodeSpec => {
    const segs = shape.segs.map(name);
    const children = materialize(shape.children, counter);
    if (shape.splat !== undefined && children.length === 0) segs.push(name(shape.splat));
    return { segs, children };
  });
}

const treeArb = fc
  .array(shapeArb(0), { minLength: 1, maxLength: 3 })
  .map((shapes) => materialize(shapes, { next: 0 }));

const pathArb = fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 4 });

describe("route grammar: agreement with a brute-force reference", () => {
  it("[A3-R6] for fixed trees, every path of up to three segments agrees with the reference", () => {
    const seg = (
      kind: SegSpec["kind"],
      name: string,
      optional: boolean,
      filtered: boolean,
    ): SegSpec => ({
      kind,
      text: "",
      name,
      optional,
      filtered,
    });
    const literal = (text: "a" | "b"): SegSpec => ({
      kind: "static",
      text,
      name: "",
      optional: false,
      filtered: false,
    });
    const node = (segs: SegSpec[], children: NodeSpec[] = []): NodeSpec => ({ segs, children });
    const trees: NodeSpec[][] = [
      [
        node([seg("param", "p0", false, false)]),
        node([seg("splat", "p1", true, false)]),
        node([literal("a")]),
      ],
      [
        node(
          [literal("a")],
          [node([seg("param", "p0", true, true)]), node([seg("splat", "p1", false, false)])],
        ),
        node([seg("param", "p2", false, false)]),
      ],
      [node([seg("splat", "p0", true, true)]), node([seg("splat", "p1", false, false)])],
    ];
    const paths: string[][] = [[]];
    for (const a of ["a", "b", "c"]) {
      paths.push([a]);
      for (const b of ["a", "b", "c"]) {
        paths.push([a, b]);
        for (const c of ["a", "b", "c"]) paths.push([a, b, c]);
      }
    }
    let hits = 0;
    for (const tree of trees) {
      for (const segs of paths) if (compareWithReference(tree, segs)) hits += 1;
    }
    expect(hits).toBeGreaterThan(40);
  });

  it("[A3-R6] random trees with optional segments, splats and filters agree with the reference (seeded)", () => {
    let hits = 0;
    fc.assert(
      fc.property(treeArb, pathArb, (tree, segs) => {
        if (compareWithReference(tree, segs)) hits += 1;
      }),
      PROPS,
    );
    // Guards against a vacuous comparison: a healthy share of the generated paths must match.
    expect(hits).toBeGreaterThan(PROPS.numRuns / 4);
  });
});

describe("matchFilters: a failing value falls through to the next candidate", () => {
  it("[A3-F1] a regex filter sends a non-numeric id to the next route, a numeric id to the first", () => {
    const tree: RouteDefinition[] = [
      { id: "post", path: "/posts/:id", matchFilters: { id: /^\d+$/ } },
      { id: "slug", path: "/posts/:slug" },
    ];
    expect(idsOf(matchRoutes(tree, "/posts/42", FILTERS))).toEqual(["post"]);
    expect(idsOf(matchRoutes(tree, "/posts/abc", FILTERS))).toEqual(["slug"]);
    expect(paramsOf(matchRoutes(tree, "/posts/abc", FILTERS)[0])).toEqual({ slug: "abc" });
  });

  it("[A3-F1] an enum list and a predicate both decide the match", () => {
    const enumTree: RouteDefinition[] = [
      { id: "lang", path: "/:lang", matchFilters: { lang: ["en", "ar"] } },
    ];
    expect(idsOf(matchRoutes(enumTree, "/en", FILTERS))).toEqual(["lang"]);
    expect(matchRoutes(enumTree, "/fr", FILTERS)).toEqual([]);
    const predicateTree: RouteDefinition[] = [
      { id: "code", path: "/c/:code", matchFilters: { code: (value) => value.length === 3 } },
    ];
    expect(idsOf(matchRoutes(predicateTree, "/c/abc", FILTERS))).toEqual(["code"]);
    expect(matchRoutes(predicateTree, "/c/abcd", FILTERS)).toEqual([]);
  });

  it("[A3-F1] a Standard Schema validator decides the match by its issues", () => {
    const lower = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "string" && /^[a-z]+$/.test(value)
            ? { value }
            : { issues: [{ message: "lowercase letters only" }] },
      },
    };
    const tree: RouteDefinition[] = [
      { id: "word", path: "/w/:word", matchFilters: { word: lower } },
    ];
    expect(idsOf(matchRoutes(tree, "/w/hello", FILTERS))).toEqual(["word"]);
    expect(matchRoutes(tree, "/w/Hello", FILTERS)).toEqual([]);
  });

  it("[A3-F1] a filter is not applied to an optional param that is absent", () => {
    const tree: RouteDefinition[] = [
      { id: "opt", path: "/posts/:lang?", matchFilters: { lang: ["en"] } },
    ];
    expect(idsOf(matchRoutes(tree, "/posts", FILTERS))).toEqual(["opt"]);
    expect(idsOf(matchRoutes(tree, "/posts/en", FILTERS))).toEqual(["opt"]);
    expect(matchRoutes(tree, "/posts/fr", FILTERS)).toEqual([]);
  });

  it("[A3-F2] nothing matches when every candidate fails: the result is empty (a 404 for the caller)", () => {
    const tree: RouteDefinition[] = [{ id: "n", path: "/n/:v", matchFilters: { v: /^\d+$/ } }];
    expect(matchRoutes(tree, "/n/x", FILTERS)).toEqual([]);
  });

  it("[A3-F2] a filter on a layout param applies to every child route", () => {
    const tree: RouteDefinition[] = [
      {
        id: "lang-layout",
        path: "/:lang",
        matchFilters: { lang: ["en"] },
        children: [{ id: "about", path: "about" }],
      },
    ];
    const hit = matchRoutes(tree, "/en/about", FILTERS);
    expect(idsOf(hit)).toEqual(["lang-layout", "about"]);
    expect(paramsOf(hit[1])).toEqual({ lang: "en" });
    expect(matchRoutes(tree, "/fr/about", FILTERS)).toEqual([]);
  });
});

describe("matchFilters: definition errors and checks", () => {
  it("[A3-F3] a filter for a name the path does not declare is a TypeError", () => {
    expect(() =>
      createMatcher([{ id: "x", path: "/a/:b", matchFilters: { c: /x/ } }], FILTERS),
    ).toThrow(TypeError);
  });

  it("[A3-F3] a global or sticky regex is refused (its state would change matches)", () => {
    expect(() =>
      createMatcher([{ id: "x", path: "/a/:b", matchFilters: { b: /x/g } }], FILTERS),
    ).toThrow(TypeError);
    expect(() =>
      createMatcher([{ id: "x", path: "/a/:b", matchFilters: { b: /x/y } }], FILTERS),
    ).toThrow(TypeError);
  });

  it("[A3-F3] an async Standard Schema is a TypeError at match time, naming the route", () => {
    const asyncSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: async (value: unknown) => ({ value }),
      },
    };
    const matcher = createMatcher(
      [{ id: "slow", path: "/s/:v", matchFilters: { v: asyncSchema } }],
      FILTERS,
    );
    expect(() => matcher.match("/s/1")).toThrow(/slow/);
    expect(() => matcher.match("/s/1")).toThrow(/synchronous/);
  });

  it("[A3-F4] checkParams names the first param that fails its filter, for typed link building", () => {
    const matcher = createMatcher(
      [{ id: "post", path: "/posts/:id", matchFilters: { id: /^\d+$/ } }],
      FILTERS,
    );
    expect(matcher.checkParams("/posts/:id", { id: "abc" })).toBe("id");
    expect(matcher.checkParams("/posts/:id", { id: "7" })).toBeUndefined();
    expect(matcher.checkParams("/unknown/:id", { id: "abc" })).toBeUndefined();
  });
});
