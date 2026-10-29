import { asciiLowercase, percentDecodeStrict } from "./encoding";
import {
  encodeSegment,
  expandOptionals,
  MAX_OPTIONAL_SEGMENTS,
  type PatternSegment,
  PatternSyntaxError,
  parsePattern,
  splitPathname,
  variantStructureKey,
} from "./path";
import { SieveCache } from "./sieve";

/**
 * Route tree matching.
 *
 * Routes form a tree. Only leaves are endpoints: a route with children matches a path through
 * its leaves (use an index child with `path: ""` for the page at a layout's own path). A match is
 * the root-to-leaf chain, with the params each route on the chain declares (params accumulate
 * down the chain).
 *
 * Priority, at each segment: static > param > optional > splat, then declaration order. The trie
 * walk is iterative, so the depth of a user-supplied path cannot exhaust the call stack.
 */

/**
 * The result a Standard Schema validator returns: a value, or issues. Only the shape matters here.
 * @since 1.0.0
 */
export type ParamSchemaResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: readonly { readonly message: string }[]; readonly value?: undefined };

/**
 * A Standard Schema (https://standardschema.dev) used as a param filter. Its `validate` must answer
 * synchronously: matching is synchronous.
 * @since 1.0.0
 */
export interface ParamSchema {
  readonly "~standard": {
    readonly version?: 1;
    readonly vendor?: string;
    readonly validate: (value: unknown) => ParamSchemaResult | Promise<ParamSchemaResult>;
  };
}

/**
 * A rule for one param of a route. The value passes when: a RegExp matches it (no `g` or `y` flag),
 * it is one of the listed strings, a predicate returns true, or a Standard Schema validates it.
 * @since 1.0.0
 */
export type ParamFilter = RegExp | readonly string[] | ((value: string) => boolean) | ParamSchema;

/**
 * A route as the matcher sees it. Routers add their own fields (loaders, components) to it.
 * @since 1.0.0
 */
export interface RouteDefinition {
  readonly id: string;
  /** Path relative to the parent. Omitted means pathless (a layout that adds no segments). */
  readonly path?: string;
  readonly children?: readonly RouteDefinition[];
  /**
   * Rules for the params this route's own path declares. A match whose value fails a rule is not a
   * match: the matcher tries the next candidate, and a request that has none is not found.
   */
  readonly matchFilters?: Readonly<Record<string, ParamFilter>>;
}

/**
 * One route on a matched chain.
 * @since 1.0.0
 */
export interface RouteMatch {
  readonly id: string;
  /** The route's own path text; empty for pathless routes. */
  readonly pattern: string;
  /** Params declared by this route and its ancestors. */
  readonly params: Readonly<Record<string, string>>;
  /** Zero for the root of the chain. */
  readonly depth: number;
}

/**
 * Options shared by matching and conflict detection.
 * @since 1.0.0
 */
export interface MatcherOptions {
  /** Static segments compare ASCII case exactly. Defaults to false. */
  readonly caseSensitive?: boolean;
  /** Mount point, for example `/app`. Matched at a segment boundary only. */
  readonly basePath?: string;
  /**
   * Compiles the `matchFilters` rules of the routes. Needed only when a route declares filters; the
   * `matchFilters()` feature provides it.
   */
  readonly compileFilter?: FilterCompiler;
}

/**
 * Which routes a match may return. `"public"` is a request from outside: a private route (one whose pattern has a
 * `_`-prefixed static segment, see {@link isPrivatePattern}) is never returned, so the path falls through to the next
 * candidate or to not found. `"all"` also returns private routes: the server uses it for a rewrite target (a
 * middleware or config `rewrite()` to an internal path), and the client router for every route it was given.
 * @since 1.0.0
 */
export type RouteVisibility = "public" | "all";

/**
 * A route matcher built for one route tree.
 * @since 1.0.0
 */
export interface RouteMatcher {
  /**
   * Root-to-leaf chain for the pathname, or an empty array. The visibility decides whether private routes can
   * answer (default `"all"`). Results are cached and frozen, one cache per visibility.
   */
  match(pathname: string, visibility?: RouteVisibility): readonly RouteMatch[];
  /** Pathname relative to the base path, or undefined when it is outside the base. */
  stripBase(pathname: string): string | undefined;
  /** Joins the base path to an app-relative path. */
  addBase(path: string): string;
  /**
   * Checks params against the filters of the route pattern they are for (`/posts/:id`). Returns the
   * name of the first param whose value fails its rule, or undefined when all pass, or when no route
   * has that pattern. Typed link building uses it, so a link cannot name a route that would not match.
   */
  checkParams(
    pattern: string,
    params: Readonly<Record<string, string | undefined>>,
  ): string | undefined;
  /** Entries in the match caches (bounded, both visibilities together). */
  readonly cacheSize: number;
}

/**
 * A conflict between two routes that match the same paths.
 * @since 1.0.0
 */
export interface RouteConflict {
  readonly kind: "duplicate-id" | "ambiguous-path";
  readonly ids: readonly [string, string];
  readonly pattern: string;
}

const MATCH_CACHE_CAPACITY = 1000;
const MAX_CACHED_PATHNAME_LENGTH = 2048;
const NO_MATCHES: readonly RouteMatch[] = Object.freeze([]);

interface FlatRoute {
  readonly id: string;
  readonly path: string;
  /** Flat indices from the root to this route, inclusive. */
  readonly chain: readonly number[];
  readonly isLeaf: boolean;
  readonly filters: Readonly<Record<string, ParamFilter>> | undefined;
}

/** A compiled rule: true when the value passes. */
type Predicate = (value: string) => boolean;

/**
 * Compiles one `matchFilters` rule (the route id, the param name and the rule); throws for a rule that
 * cannot be used. The `filters` feature (`matchFilters()` from `@shadow-js/router/filters`) supplies it,
 * so the compiler is in a bundle only when a route declares filters.
 * @since 1.0.0
 */
export type FilterCompiler = (routeId: string, name: string, filter: ParamFilter) => Predicate;

/**
 * The compiled rules of every route, by flat index and param name, and the param names each route's
 * own pattern declares. A rule for a name the path does not declare is a definition error.
 */
function compileFilters(
  flat: readonly FlatRoute[],
  compile: FilterCompiler | undefined,
): Map<number, Map<string, Predicate>> {
  const compiled = new Map<number, Map<string, Predicate>>();
  flat.forEach((route, index) => {
    if (route.filters === undefined) return;
    const declared = new Set(
      parsePattern(route.path).segments.flatMap((segment) =>
        segment.kind === "static" ? [] : [segment.name],
      ),
    );
    const rules = new Map<string, Predicate>();
    for (const [name, filter] of Object.entries(route.filters)) {
      if (!declared.has(name)) {
        throw new TypeError(
          __DEV__
            ? `matchFilters.${name} of route "${route.id}" names no param of "${route.path}" (its params: ${[...declared].join(", ") || "none"})`
            : "SHADOW_FILTER_NAME",
        );
      }
      if (compile === undefined) {
        throw new TypeError(
          __DEV__
            ? `route "${route.id}" declares matchFilters, which need the matchFilters feature: pass matchFilters() (from @shadow-js/router/filters) to createRouter, or compileFilter to createMatcher`
            : "SHADOW_FILTER_FEATURE",
        );
      }
      rules.set(name, compile(route.id, name, filter));
    }
    if (rules.size > 0) compiled.set(index, rules);
  });
  return compiled;
}

/** A segment of an endpoint, tagged with the depth of the route that declared it. */
interface Piece {
  readonly segment: PatternSegment;
  readonly owner: number;
}

interface Endpoint {
  readonly leaf: number;
  readonly pieces: readonly Piece[];
}

/** True for a segment that makes a route private: a static segment that starts with an underscore. */
function isPrivateSegment(segment: PatternSegment): boolean {
  return segment.kind === "static" && segment.canonical.startsWith("_");
}

/**
 * True when a URL pattern is private: one of its static segments starts with `_` (`/_preview/:id`, `/posts/_draft`).
 * Such a route is internal: a request from outside never matches it (see {@link RouteVisibility}), and the scanner
 * marks it. The convention: a leading underscore on a static segment makes the whole route private.
 *
 * @param pattern A URL pattern such as `/_preview/:id`.
 * @returns True when the pattern is private.
 * @throws PatternSyntaxError for an invalid pattern.
 * @since 1.0.0
 * @example isPrivatePattern("/_preview/:id") // true
 */
export function isPrivatePattern(pattern: string): boolean {
  return parsePattern(pattern).segments.some(isPrivateSegment);
}

interface Slot {
  readonly name: string;
  readonly owner: number;
  readonly splat: boolean;
}

interface Entry {
  readonly leaf: number;
  readonly slots: readonly Slot[];
  /** True when the endpoint's pattern is private (see {@link isPrivatePattern}). */
  readonly hidden: boolean;
}

interface TrieNode {
  readonly statics: Map<string, TrieNode>;
  param: TrieNode | undefined;
  optional: TrieNode | undefined;
  readonly terminals: Entry[];
  readonly splats: Entry[];
}

interface Capture {
  readonly value: string;
  readonly previous: Capture | undefined;
}

interface Segment {
  readonly key: string;
  readonly value: string;
}

type Task =
  | {
      readonly kind: "visit";
      readonly node: TrieNode;
      readonly index: number;
      readonly captures: Capture | undefined;
    }
  | {
      readonly kind: "emit";
      readonly entry: Entry;
      readonly captures: Capture | undefined;
      /** Index where a splat's rest starts, or -1 when the entry is a terminal. */
      readonly restFrom: number;
    };

type EmitTask = Extract<Task, { kind: "emit" }>;

function newNode(): TrieNode {
  return { statics: new Map(), param: undefined, optional: undefined, terminals: [], splats: [] };
}

/** Flattens the tree in declaration (pre-)order without recursion. */
function flattenRoutes(tree: readonly RouteDefinition[]): FlatRoute[] {
  const flat: FlatRoute[] = [];
  const stack: { definition: RouteDefinition; parentChain: readonly number[] }[] = [];
  for (let index = tree.length - 1; index >= 0; index -= 1) {
    const definition = tree[index];
    if (definition !== undefined) stack.push({ definition, parentChain: [] });
  }
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const flatIndex = flat.length;
    const chain = [...item.parentChain, flatIndex];
    const children = item.definition.children ?? [];
    flat.push({
      id: item.definition.id,
      path: item.definition.path ?? "",
      chain,
      isLeaf: children.length === 0,
      filters: item.definition.matchFilters,
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ definition: child, parentChain: chain });
    }
  }
  return flat;
}

function optionalCount(pieces: readonly Piece[]): number {
  let count = 0;
  for (const piece of pieces) {
    if (piece.segment.kind === "optional") count += 1;
  }
  return count;
}

/**
 * Builds every endpoint of the tree. Each route's own variants are combined with the variants of
 * its ancestors (only leaves become endpoints), and structural duplicates are dropped per route.
 */
function buildEndpoints(flat: readonly FlatRoute[], caseSensitive: boolean): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const combinedByRoute: Piece[][][] = [];
  for (let index = 0; index < flat.length; index += 1) {
    const route = flat[index];
    if (route === undefined) continue;
    const depth = route.chain.length - 1;
    const parentIndex = route.chain[route.chain.length - 2];
    const prefixes: Piece[][] =
      parentIndex === undefined ? [[]] : (combinedByRoute[parentIndex] ?? [[]]);
    const ownVariants = expandOptionals(parsePattern(route.path).segments, caseSensitive);

    const product: Piece[][] = [];
    const seen = new Set<string>();
    for (const prefix of prefixes) {
      for (const variant of ownVariants) {
        const pieces: Piece[] = [
          ...prefix,
          ...variant.map((segment) => ({ segment, owner: depth })),
        ];
        if (optionalCount(pieces) > MAX_OPTIONAL_SEGMENTS) {
          throw new PatternSyntaxError(
            __DEV__
              ? `route "${route.id}" has more than ${MAX_OPTIONAL_SEGMENTS} optional segments on one path`
              : "SHADOW_TOO_MANY_OPTIONALS",
          );
        }
        const key = variantStructureKey(
          pieces.map((piece) => piece.segment),
          caseSensitive,
        );
        if (!seen.has(key)) {
          seen.add(key);
          product.push(pieces);
        }
      }
    }
    combinedByRoute[index] = product;
    if (route.isLeaf) {
      for (const pieces of product) endpoints.push({ leaf: index, pieces });
    }
  }
  return endpoints;
}

function insertEndpoint(root: TrieNode, endpoint: Endpoint, caseSensitive: boolean): void {
  let node = root;
  const slots: Slot[] = [];
  let splat = false;
  for (const piece of endpoint.pieces) {
    const segment = piece.segment;
    if (segment.kind === "static") {
      const key = caseSensitive ? segment.canonical : asciiLowercase(segment.canonical);
      let child = node.statics.get(key);
      if (child === undefined) {
        child = newNode();
        node.statics.set(key, child);
      }
      node = child;
    } else if (segment.kind === "param") {
      slots.push({ name: segment.name, owner: piece.owner, splat: false });
      if (node.param === undefined) node.param = newNode();
      node = node.param;
    } else if (segment.kind === "optional") {
      slots.push({ name: segment.name, owner: piece.owner, splat: false });
      if (node.optional === undefined) node.optional = newNode();
      node = node.optional;
    } else {
      slots.push({ name: segment.name, owner: piece.owner, splat: true });
      splat = true;
      break;
    }
  }
  const entry: Entry = {
    leaf: endpoint.leaf,
    slots,
    hidden: endpoint.pieces.some((piece) => isPrivateSegment(piece.segment)),
  };
  if (splat) {
    node.splats.push(entry);
  } else {
    node.terminals.push(entry);
  }
}

/**
 * Walks the trie for the given segments. Iterative: a stack of pending tasks, pushed so that the
 * highest-priority alternative is popped first. A candidate the `accept` callback refuses (a failed
 * matchFilters rule) is skipped and the walk goes on with the next one.
 *
 * A splat needs at least one segment: at the end of the path only terminals match.
 */
/**
 * Pushes the candidates of one trie node so that the first declared is popped first. Candidates
 * with the same structure share a node; each one is a separate chance for a filter to pass.
 */
function pushInOrder(stack: Task[], entries: readonly Entry[], make: (entry: Entry) => Task): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined) stack.push(make(entry));
  }
}

function searchTrie(
  root: TrieNode,
  segments: readonly Segment[],
  accept: (candidate: EmitTask) => boolean,
): EmitTask | undefined {
  const stack: Task[] = [{ kind: "visit", node: root, index: 0, captures: undefined }];
  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) break;
    if (task.kind === "emit") {
      if (accept(task)) return task;
      continue;
    }

    const { node, index, captures } = task;
    if (index === segments.length) {
      pushInOrder(stack, node.terminals, (entry) => ({
        kind: "emit",
        entry,
        captures,
        restFrom: -1,
      }));
      continue;
    }

    const segment = segments[index];
    if (segment === undefined) continue;
    pushInOrder(stack, node.splats, (entry) => ({
      kind: "emit",
      entry,
      captures,
      restFrom: index,
    }));
    if (node.optional !== undefined) {
      stack.push({
        kind: "visit",
        node: node.optional,
        index: index + 1,
        captures: { value: segment.value, previous: captures },
      });
    }
    if (node.param !== undefined) {
      stack.push({
        kind: "visit",
        node: node.param,
        index: index + 1,
        captures: { value: segment.value, previous: captures },
      });
    }
    const child = node.statics.get(segment.key);
    if (child !== undefined) {
      stack.push({ kind: "visit", node: child, index: index + 1, captures });
    }
  }
  return undefined;
}

function captureValues(captures: Capture | undefined): string[] {
  const values: string[] = [];
  for (let link = captures; link !== undefined; link = link.previous) {
    values.push(link.value);
  }
  return values.reverse();
}

/** The decoded value of every slot of a candidate, aligned with its slots. */
function slotValuesOf(found: EmitTask, segments: readonly Segment[]): string[] {
  const values = captureValues(found.captures);
  const rest =
    found.restFrom < 0
      ? ""
      : segments
          .slice(found.restFrom)
          .map((segment) => segment.value)
          .join("/");
  const slotValues: string[] = [];
  let next = 0;
  for (const slot of found.entry.slots) {
    if (slot.splat) {
      slotValues.push(rest);
    } else {
      slotValues.push(values[next] ?? "");
      next += 1;
    }
  }
  return slotValues;
}

function buildChain(
  flat: readonly FlatRoute[],
  found: EmitTask,
  segments: readonly Segment[],
): readonly RouteMatch[] {
  const route = flat[found.entry.leaf];
  if (route === undefined) return NO_MATCHES;
  const slotValues = slotValuesOf(found, segments);

  const matches: RouteMatch[] = [];
  for (let depth = 0; depth < route.chain.length; depth += 1) {
    const chainIndex = route.chain[depth];
    const declared = chainIndex === undefined ? undefined : flat[chainIndex];
    if (declared === undefined) continue;
    const params: Record<string, string> = Object.create(null);
    for (let slotIndex = 0; slotIndex < found.entry.slots.length; slotIndex += 1) {
      const slot = found.entry.slots[slotIndex];
      if (slot !== undefined && slot.owner <= depth) {
        params[slot.name] = slotValues[slotIndex] ?? "";
      }
    }
    matches.push(
      Object.freeze({
        id: declared.id,
        pattern: declared.path,
        params: Object.freeze(params),
        depth,
      }),
    );
  }
  return Object.freeze(matches);
}

function renderPattern(pieces: readonly Piece[]): string {
  const parts: string[] = [];
  for (const piece of pieces) {
    const segment = piece.segment;
    if (segment.kind === "static") parts.push(segment.canonical);
    else if (segment.kind === "param") parts.push(`:${segment.name}`);
    else if (segment.kind === "optional") parts.push(`:${segment.name}?`);
    else parts.push(`*${segment.name}`);
  }
  return `/${parts.join("/")}`;
}

/**
 * Builds a matcher for a route tree. Build once per router instance: the trie and the cache are
 * owned by the returned object.
 *
 * @param tree Top-level routes, in declaration order.
 * @param options Case policy and base path.
 * @returns A matcher.
 * @throws PatternSyntaxError for an invalid pattern in the tree.
 * @throws RangeError for a base path with malformed escapes.
 * @example createMatcher([{ id: "post", path: "/posts/:id" }]).match("/posts/7")
 * @since 1.0.0
 */
export function createMatcher(
  tree: readonly RouteDefinition[],
  options: MatcherOptions = {},
): RouteMatcher {
  const caseSensitive = options.caseSensitive ?? false;
  const flat = flattenRoutes(tree);
  const filterRules = compileFilters(flat, options.compileFilter);
  const root = newNode();
  const endpoints = buildEndpoints(flat, caseSensitive);
  for (const endpoint of endpoints) {
    insertEndpoint(root, endpoint, caseSensitive);
  }
  const checks = indexChecks(endpoints, flat, filterRules);

  /** True when every rule of the candidate's declaring routes accepts its value. */
  const accept = (candidate: EmitTask, segments: readonly Segment[]): boolean => {
    if (filterRules.size === 0) return true;
    const route = flat[candidate.entry.leaf];
    if (route === undefined) return false;
    const values = slotValuesOf(candidate, segments);
    for (let index = 0; index < candidate.entry.slots.length; index += 1) {
      const slot = candidate.entry.slots[index];
      if (slot === undefined) continue;
      const declaring = route.chain[slot.owner];
      if (declaring === undefined) continue;
      const test = filterRules.get(declaring)?.get(slot.name);
      if (test !== undefined && !test(values[index] ?? "")) return false;
    }
    return true;
  };

  const basePieces = baseSegments(options.basePath ?? "");
  const baseKeys = basePieces.map((piece) => (caseSensitive ? piece : asciiLowercase(piece)));
  // One cache per visibility: the same path answers differently for a request from outside and a rewrite.
  const cache = new SieveCache<string, readonly RouteMatch[]>(MATCH_CACHE_CAPACITY);
  const publicCache = new SieveCache<string, readonly RouteMatch[]>(MATCH_CACHE_CAPACITY);

  function stripBase(pathname: string): string | undefined {
    if (baseKeys.length === 0) return pathname;
    const raw = splitPathname(pathname);
    if (raw === undefined || raw.length < baseKeys.length) return undefined;
    for (let index = 0; index < baseKeys.length; index += 1) {
      const piece = raw[index];
      const decoded = piece === undefined ? undefined : percentDecodeStrict(piece);
      if (decoded === undefined) return undefined;
      const canonical = encodeSegment(decoded);
      const key = caseSensitive ? canonical : asciiLowercase(canonical);
      if (key !== baseKeys[index]) return undefined;
    }
    const rest = raw.slice(baseKeys.length);
    return rest.length === 0 ? "/" : `/${rest.join("/")}`;
  }

  function computeMatches(pathname: string, visibility: RouteVisibility): readonly RouteMatch[] {
    const appPath = stripBase(pathname);
    if (appPath === undefined) return NO_MATCHES;
    const raw = splitPathname(appPath);
    if (raw === undefined) return NO_MATCHES;
    const segments: Segment[] = [];
    for (const piece of raw) {
      const decoded = percentDecodeStrict(piece);
      if (decoded === undefined) return NO_MATCHES;
      const canonical = encodeSegment(decoded);
      segments.push({
        key: caseSensitive ? canonical : asciiLowercase(canonical),
        value: decoded,
      });
    }
    const found = searchTrie(
      root,
      segments,
      (candidate) =>
        (visibility === "all" || !candidate.entry.hidden) && accept(candidate, segments),
    );
    if (found === undefined) return NO_MATCHES;
    return buildChain(flat, found, segments);
  }

  return {
    match(pathname: string, visibility: RouteVisibility = "all"): readonly RouteMatch[] {
      const store = visibility === "public" ? publicCache : cache;
      const cached = store.get(pathname);
      if (cached !== undefined) return cached;
      const result = computeMatches(pathname, visibility);
      if (pathname.length <= MAX_CACHED_PATHNAME_LENGTH) store.set(pathname, result);
      return result;
    },
    stripBase,
    addBase(path: string): string {
      if (basePieces.length === 0) return path;
      const tail = splitPathname(path);
      if (tail === undefined) {
        throw new RangeError(
          __DEV__ ? `cannot add a base to the invalid path "${path}"` : "SHADOW_BASE_PATH_ADD",
        );
      }
      return `/${[...basePieces, ...tail].join("/")}`;
    },
    checkParams(
      pattern: string,
      params: Readonly<Record<string, string | undefined>>,
    ): string | undefined {
      const list = checks.get(pattern);
      if (list === undefined) return undefined;
      for (const check of list) {
        const value = params[check.name];
        if (value !== undefined && !check.test(value)) return check.name;
      }
      return undefined;
    },
    get cacheSize(): number {
      return cache.size + publicCache.size;
    },
  };
}

/**
 * The rules that apply to each endpoint pattern, for {@link RouteMatcher.checkParams}. The first
 * endpoint with a pattern decides, as the matcher does for a path.
 */
function indexChecks(
  endpoints: readonly Endpoint[],
  flat: readonly FlatRoute[],
  rules: ReadonlyMap<number, ReadonlyMap<string, Predicate>>,
): ReadonlyMap<string, readonly { readonly name: string; readonly test: Predicate }[]> {
  const index = new Map<string, { readonly name: string; readonly test: Predicate }[]>();
  for (const endpoint of endpoints) {
    const pattern = renderPattern(endpoint.pieces);
    if (index.has(pattern)) continue;
    const list: { readonly name: string; readonly test: Predicate }[] = [];
    const leaf = flat[endpoint.leaf];
    for (const piece of endpoint.pieces) {
      if (piece.segment.kind === "static" || leaf === undefined) continue;
      const declaring = leaf.chain[piece.owner];
      if (declaring === undefined) continue;
      const test = rules.get(declaring)?.get(piece.segment.name);
      if (test !== undefined) list.push({ name: piece.segment.name, test });
    }
    index.set(pattern, list);
  }
  return index;
}

/**
 * Matches a route tree against a pathname (builds a matcher each call; prefer
 * {@link createMatcher} when matching repeatedly).
 *
 * @param tree Top-level routes.
 * @param pathname Pathname such as `/users/5/profile`.
 * @param options Case policy and base path.
 * @returns The root-to-leaf chain, or an empty array.
 * @example matchRoutes([{ id: "u", path: "/users/:id" }], "/users/5")[0]?.params // { id: "5" }
 * @since 1.0.0
 */
export function matchRoutes(
  tree: readonly RouteDefinition[],
  pathname: string,
  options?: MatcherOptions,
): readonly RouteMatch[] {
  return createMatcher(tree, options).match(pathname);
}

/**
 * Reports pairs of routes that cannot be told apart: duplicate ids, and endpoints with the same
 * structure (same segment kinds and static text, regardless of param names).
 *
 * @param tree Top-level routes.
 * @param options Case policy (affects which static segments count as equal).
 * @returns Conflicts in declaration order; empty when the tree is unambiguous.
 * @example
 * import { findConflicts } from "@shadow-js/router/core";
 * findConflicts([
 *   { id: "post", path: "/posts/:id" },
 *   { id: "article", path: "/posts/:slug" },
 * ]).length; // 1: the two endpoints differ only in the param name
 * @since 1.0.0
 */
export function findConflicts(
  tree: readonly RouteDefinition[],
  options: MatcherOptions = {},
): RouteConflict[] {
  const caseSensitive = options.caseSensitive ?? false;
  const flat = flattenRoutes(tree);
  const conflicts: RouteConflict[] = [];

  const firstById = new Map<string, string>();
  for (const route of flat) {
    const first = firstById.get(route.id);
    if (first === undefined) {
      firstById.set(route.id, route.id);
    } else {
      conflicts.push({ kind: "duplicate-id", ids: [first, route.id], pattern: route.path });
    }
  }

  const firstByStructure = new Map<string, Endpoint>();
  for (const endpoint of buildEndpoints(flat, caseSensitive)) {
    const key = variantStructureKey(
      endpoint.pieces.map((piece) => piece.segment),
      caseSensitive,
    );
    const first = firstByStructure.get(key);
    if (first === undefined) {
      firstByStructure.set(key, endpoint);
      continue;
    }
    const firstRoute = flat[first.leaf];
    const laterRoute = flat[endpoint.leaf];
    if (firstRoute !== undefined && laterRoute !== undefined && first.leaf !== endpoint.leaf) {
      conflicts.push({
        kind: "ambiguous-path",
        ids: [firstRoute.id, laterRoute.id],
        pattern: renderPattern(endpoint.pieces),
      });
    }
  }
  return conflicts;
}

/** The rank of each segment kind, the order the trie walk tries them in (lower is more specific). */
const SPECIFICITY: Readonly<Record<PatternSegment["kind"], number>> = {
  static: 0,
  param: 1,
  optional: 2,
  splat: 3,
};

/**
 * Orders two URL patterns by the priority the matcher gives them. At the first segment where they differ, a static
 * segment beats a param, a param beats an optional param, and an optional param beats a splat (the order of the trie
 * walk). A pattern that ends where the other still has segments is the more specific one. Param names do not count.
 *
 * Dusk uses it to choose between an API route, a stream route and a page that match the same request.
 *
 * @param a A URL pattern.
 * @param b Another URL pattern.
 * @returns A negative number when `a` is more specific, a positive one when `b` is, `0` for patterns of one shape.
 * @throws PatternSyntaxError for an invalid pattern.
 * @since 1.0.0
 * @example comparePatterns("/f/:id/preview", "/f/:id/:name") // negative: the static segment wins
 */
export function comparePatterns(a: string, b: string): number {
  const left = parsePattern(a).segments;
  const right = parsePattern(b).segments;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return y === undefined ? 0 : -1;
    if (y === undefined) return 1;
    const difference = SPECIFICITY[x.kind] - SPECIFICITY[y.kind];
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * A matcher that answers with one visibility: the same routes, asked with `visibility` on every `match`. A router built
 * for a request from outside (`visibility: "public"`) uses it, so its navigator never matches a private route. With
 * `"all"` the matcher is returned as it is.
 *
 * @param matcher The matcher to restrict.
 * @param visibility The visibility every `match` uses.
 * @returns A matcher with the same methods.
 * @example
 * import { createMatcher, restrictMatcher } from "@shadow-js/router/core";
 * const matcher = createMatcher([{ id: "home", path: "/" }, { id: "preview", path: "/_preview/:id" }]);
 * restrictMatcher(matcher, "public").match("/_preview/7"); // []: the private route does not answer
 * @since 1.0.0
 */
export function restrictMatcher(matcher: RouteMatcher, visibility: RouteVisibility): RouteMatcher {
  if (visibility === "all") return matcher;
  return {
    match: (pathname: string) => matcher.match(pathname, visibility),
    stripBase: (pathname: string) => matcher.stripBase(pathname),
    addBase: (path: string) => matcher.addBase(path),
    checkParams: (pattern, params) => matcher.checkParams(pattern, params),
    get cacheSize(): number {
      return matcher.cacheSize;
    },
  };
}

/** Canonical base path segments, for building and matching. Throws on a malformed escape. */
function baseSegments(basePath: string): string[] {
  const raw = splitPathname(basePath);
  if (raw === undefined) {
    throw new RangeError(__DEV__ ? `invalid base path "${basePath}"` : "SHADOW_BASE_PATH");
  }
  return raw.map((piece) => {
    const decoded = percentDecodeStrict(piece);
    if (decoded === undefined) {
      throw new RangeError(__DEV__ ? `invalid base path "${basePath}"` : "SHADOW_BASE_PATH");
    }
    return encodeSegment(decoded);
  });
}
