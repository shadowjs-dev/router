import { asciiLowercase, percentDecodeStrict, percentEncodeText } from "./encoding";

/**
 * Route pattern syntax, path canonicalization and typed `buildPath`.
 *
 * Pattern syntax: `/users/:id`, optional `/users/:id?`, splat `/files/*rest` or bare `/files/*`
 * (the splat captures the rest of the path, slashes included, under key `*`).
 *
 * Path rules: decode once; `%2F`, `%25` and `%5C` stay escaped in the canonical form; everything
 * outside RFC 3986 `pchar` is re-encoded; empty interior segments are rejected; malformed
 * percent escapes are reported as `undefined`, never thrown.
 */

/**
 * Trailing-slash policy used when producing a canonical pathname.
 * @since 1.0.0
 */
export type TrailingSlashPolicy = "never" | "always" | "preserve";

/**
 * A literal path segment. `canonical` is the escaped form used for comparison.
 * @since 1.0.0
 */
export interface StaticSegment {
  readonly kind: "static";
  readonly text: string;
  readonly canonical: string;
}

/**
 * A required `:name` segment.
 * @since 1.0.0
 */
export interface ParamSegment {
  readonly kind: "param";
  readonly name: string;
}

/**
 * An optional `:name?` segment. Expanded into a present and an absent variant.
 * @since 1.0.0
 */
export interface OptionalSegment {
  readonly kind: "optional";
  readonly name: string;
}

/**
 * A `*name` splat: the rest of the path, at least one segment (`/files/*rest` does not match
 * `/files`). `*name?` is the optional catch-all: it also matches the path without the rest, and is
 * expanded into a splat variant and an absent variant. Always the last segment. Bare `*` is named `*`.
 * @since 1.0.0
 */
export interface SplatSegment {
  readonly kind: "splat";
  readonly name: string;
  /** Present only on the optional form `*name?`. */
  readonly optional?: true;
}

/**
 * One parsed segment of a route pattern.
 * @since 1.0.0
 */
export type PatternSegment = StaticSegment | ParamSegment | OptionalSegment | SplatSegment;

/**
 * A parsed route pattern.
 * @since 1.0.0
 */
export interface ParsedPattern {
  readonly source: string;
  readonly segments: readonly PatternSegment[];
}

/**
 * Maximum number of optional segments in one pattern. Expansion produces up to 2^n variants, so
 * the cap keeps the route table bounded.
 * @example
 * import { MAX_OPTIONAL_SEGMENTS } from "@shadow-js/router/core";
 * MAX_OPTIONAL_SEGMENTS; // 8
 * @since 1.0.0
 */
export const MAX_OPTIONAL_SEGMENTS = 8;

/**
 * Thrown for an invalid route pattern. Patterns are developer-authored, so this is a build error.
 * @example
 * import { parsePattern, PatternSyntaxError } from "@shadow-js/router/core";
 * try {
 *   parsePattern("/posts/:id/:id");
 * } catch (error) {
 *   error instanceof PatternSyntaxError; // true: duplicate param "id"
 * }
 * @since 1.0.0
 */
export class PatternSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternSyntaxError";
  }
}

/**
 * Escapes text for a static pattern segment (decoded text in, canonical form out).
 * @example
 * import { encodeSegment } from "@shadow-js/router/core";
 * encodeSegment("a b"); // "a%20b"
 * @since 1.0.0
 */
export function encodeSegment(value: string): string {
  return percentEncodeText(value);
}

/**
 * Decodes one raw path segment once. Returns undefined when it has a malformed escape.
 * @example
 * import { decodeSegment } from "@shadow-js/router/core";
 * decodeSegment("caf%C3%A9"); // "café"
 * decodeSegment("%zz"); // undefined: malformed escape
 * @since 1.0.0
 */
export function decodeSegment(raw: string): string | undefined {
  return percentDecodeStrict(raw);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function assertParamName(name: string, pattern: string): void {
  let valid = name.length > 0;
  for (let index = 0; valid && index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    const allowed = isAsciiLetter(code) || code === 0x5f || (index > 0 && isAsciiDigit(code));
    valid = allowed;
  }
  if (!valid) {
    throw new PatternSyntaxError(
      __DEV__ ? `invalid param name "${name}" in pattern "${pattern}"` : "SHADOW_PARAM_NAME",
    );
  }
}

function parseSegment(raw: string, pattern: string, isLast: boolean): PatternSegment {
  const head = raw.charAt(0);
  if (head === ":") {
    const optional = raw.endsWith("?");
    const name = optional ? raw.slice(1, -1) : raw.slice(1);
    assertParamName(name, pattern);
    return optional ? { kind: "optional", name } : { kind: "param", name };
  }
  if (head === "*") {
    if (!isLast) {
      throw new PatternSyntaxError(
        __DEV__ ? `a splat must be the last segment in "${pattern}"` : "SHADOW_SPLAT_POSITION",
      );
    }
    const optional = raw.endsWith("?");
    const name = optional ? raw.slice(1, -1) : raw.slice(1);
    if (name === "") {
      return optional ? { kind: "splat", name: "*", optional: true } : { kind: "splat", name: "*" };
    }
    assertParamName(name, pattern);
    return optional ? { kind: "splat", name, optional: true } : { kind: "splat", name };
  }
  return { kind: "static", text: raw, canonical: encodeSegment(raw) };
}

/**
 * Parses a route pattern.
 *
 * @param pattern Pattern such as `/users/:id/:slug?/*rest`.
 * @returns The segments in order.
 * @throws PatternSyntaxError for duplicate names, misplaced splats, bad names, interior empty
 *   segments, or more than {@link MAX_OPTIONAL_SEGMENTS} optional segments.
 * @example parsePattern("/posts/:id").segments // [static posts, param id]
 * @since 1.0.0
 */
export function parsePattern(pattern: string): ParsedPattern {
  const parts = pattern.split("/");
  let start = 0;
  let end = parts.length;
  if (parts[0] === "") start = 1;
  if (end > start && parts[end - 1] === "") end -= 1;

  const segments: PatternSegment[] = [];
  const names = new Set<string>();
  let optionals = 0;
  for (let index = start; index < end; index += 1) {
    const raw = parts[index] ?? "";
    if (raw === "") {
      throw new PatternSyntaxError(
        __DEV__ ? `empty segment in pattern "${pattern}"` : "SHADOW_EMPTY_SEGMENT",
      );
    }
    const segment = parseSegment(raw, pattern, index === end - 1);
    if (segment.kind !== "static") {
      if (names.has(segment.name)) {
        throw new PatternSyntaxError(
          __DEV__ ? `duplicate param "${segment.name}" in "${pattern}"` : "SHADOW_DUPLICATE_PARAM",
        );
      }
      names.add(segment.name);
    }
    if (segment.kind === "optional" || (segment.kind === "splat" && segment.optional === true)) {
      optionals += 1;
    }
    segments.push(segment);
  }
  if (optionals > MAX_OPTIONAL_SEGMENTS) {
    throw new PatternSyntaxError(
      __DEV__
        ? `pattern "${pattern}" has ${optionals} optional segments (max ${MAX_OPTIONAL_SEGMENTS})`
        : "SHADOW_TOO_MANY_OPTIONALS",
    );
  }
  return { source: pattern, segments };
}

/**
 * Structural identity of a variant: segment kinds and static text, never param names. Two variants
 * with the same key match exactly the same paths.
 *
 * @param variant Segments of one variant.
 * @param caseSensitive Whether static text is compared with its ASCII case.
 * @returns Opaque key; equal for structurally identical variants.
 * @example
 * variantStructureKey(parsePattern("/posts/:id").segments, false) === variantStructureKey(parsePattern("/posts/:slug").segments, false); // true: param names do not count
 * @since 1.0.0
 */
export function variantStructureKey(
  variant: readonly PatternSegment[],
  caseSensitive: boolean,
): string {
  let key = "";
  for (const segment of variant) {
    if (segment.kind === "static") {
      const text = caseSensitive ? segment.canonical : asciiLowercase(segment.canonical);
      key += `s${text.length}:${text}`;
    } else if (segment.kind === "param") {
      key += "p";
    } else if (segment.kind === "optional") {
      key += "o";
    } else {
      key += "a";
    }
  }
  return key;
}

/**
 * Expands optional segments into concrete variants. Each optional segment yields a present
 * variant (`optional` kind) and an absent variant. Variants with the same structure are dropped
 * after the first, so `/:a?/:b?` yields `/:a/:b`, `/:a`, and `/` (never two `/:x` variants).
 *
 * Iterative, so the work is bounded by {@link MAX_OPTIONAL_SEGMENTS}, not by recursion depth.
 *
 * @param segments Parsed segments.
 * @param caseSensitive Whether static segments differing only in ASCII case are distinct.
 * @returns Variants in priority order (present before absent, left to right).
 * @example
 * import { expandOptionals, parsePattern } from "@shadow-js/router/core";
 * expandOptionals(parsePattern("/:a?/:b?").segments).length; // 3: /:a/:b, /:a and /
 * @since 1.0.0
 */
export function expandOptionals(
  segments: readonly PatternSegment[],
  caseSensitive: boolean = false,
): PatternSegment[][] {
  let variants: PatternSegment[][] = [[]];
  for (const segment of segments) {
    const next: PatternSegment[][] = [];
    for (const variant of variants) {
      if (segment.kind === "splat" && segment.optional === true) {
        // `*rest?` is the required splat, or nothing (the path ends at the folder).
        next.push([...variant, { kind: "splat", name: segment.name }]);
        next.push(variant);
        continue;
      }
      next.push([...variant, segment]);
      if (segment.kind === "optional") next.push(variant);
    }
    variants = next;
  }
  const seen = new Set<string>();
  const unique: PatternSegment[][] = [];
  for (const variant of variants) {
    const key = variantStructureKey(variant, caseSensitive);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(variant);
    }
  }
  return unique;
}

/**
 * Splits a pathname into raw (still escaped) segments. A leading and a single trailing slash are
 * ignored. Interior empty segments make the pathname invalid.
 *
 * @param pathname Path such as `/a/b/`.
 * @returns Raw segments, or undefined when the pathname has an empty interior segment.
 * @example
 * import { splitPathname } from "@shadow-js/router/core";
 * splitPathname("/a/b/"); // ["a", "b"]
 * splitPathname("/a//b"); // undefined: an interior empty segment
 * @since 1.0.0
 */
export function splitPathname(pathname: string): string[] | undefined {
  const parts = pathname.split("/");
  let start = 0;
  let end = parts.length;
  if (parts[0] === "") start = 1;
  if (end > start && parts[end - 1] === "") end -= 1;
  const raw: string[] = [];
  for (let index = start; index < end; index += 1) {
    const segment = parts[index] ?? "";
    if (segment === "") return undefined;
    raw.push(segment);
  }
  return raw;
}

/**
 * Produces the canonical form of a pathname: each segment decoded once and re-encoded, the
 * trailing slash set by `policy`.
 *
 * @param pathname Raw pathname as the browser reports it or as a caller wrote it.
 * @param policy Trailing-slash policy; defaults to `never`.
 * @returns Canonical pathname, or undefined when it is invalid (empty interior segment or a
 *   malformed escape). Never throws.
 * @example canonicalizePathname("/caf%C3%A9/") // "/caf%C3%A9"
 * @since 1.0.0
 */
export function canonicalizePathname(
  pathname: string,
  policy: TrailingSlashPolicy = "never",
): string | undefined {
  const raw = splitPathname(pathname);
  if (raw === undefined) return undefined;
  const segments: string[] = [];
  for (const piece of raw) {
    const decoded = percentDecodeStrict(piece);
    if (decoded === undefined) return undefined;
    segments.push(percentEncodeText(decoded));
  }
  if (segments.length === 0) return "/";
  let result = `/${segments.join("/")}`;
  const hadTrailingSlash = pathname.endsWith("/");
  if (policy === "always" || (policy === "preserve" && hadTrailingSlash)) {
    result += "/";
  }
  return result;
}

/** Params a pattern declares, as a type. Required `:id`, optional `:id?`, splat `*rest` or `*`. */
type SplitPath<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? [Head, ...SplitPath<Tail>]
  : [P];

type SegmentParams<S extends string> = S extends `:${infer N}?`
  ? { [K in N]?: string }
  : S extends `:${infer N}`
    ? { [K in N]: string }
    : S extends `*${infer N}?`
      ? { [K in N extends "" ? "*" : N]?: string }
      : S extends `*${infer N}`
        ? { [K in N extends "" ? "*" : N]: string }
        : Record<never, never>;

type ParamsFromSegments<S extends readonly string[]> = S extends readonly [
  infer Head extends string,
  ...infer Tail extends string[],
]
  ? SegmentParams<Head> & ParamsFromSegments<Tail>
  : Record<never, never>;

type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * The params object a pattern requires.
 *
 * @example ParamsOf<"/a/:id/:slug?/*rest"> // { id: string; slug?: string; rest: string }
 * @since 1.0.0
 */
export type ParamsOf<P extends string> = Simplify<ParamsFromSegments<SplitPath<P>>>;

/**
 * Builds a concrete path from a literal pattern with typed params.
 *
 * @param pattern Route pattern.
 * @param params Values for each required param (and any optional params that should appear).
 * @returns Escaped path beginning with `/`.
 * @throws RangeError when a required param is missing or empty, when a present optional follows
 *   a missing one (the result would match a different variant), or when a param value (or a piece of a
 *   splat value) is `.` or `..`. A browser and the WHATWG URL parser collapse those dot segments, also
 *   when written `%2e`, so no escaped form of them reaches the route; a link built from one would go to
 *   another page.
 * @example buildPath("/users/:id", { id: "a b" }) // "/users/a%20b"
 * @since 1.0.0
 */
export function buildPath<P extends string>(pattern: P, params: ParamsOf<P>): string {
  // ParamsOf<P> is a deferred conditional type, so TypeScript cannot relate it to a plain record.
  // It is always an object whose values are strings or undefined, which is what the loose
  // builder reads.
  return buildPathFromParams(
    pattern,
    params as unknown as Readonly<Record<string, string | undefined>>,
  );
}

/**
 * Untyped form of {@link buildPath}, for patterns known only at runtime.
 *
 * @param pattern Route pattern.
 * @param params Param values by name.
 * @returns Escaped path.
 * @throws RangeError as {@link buildPath} does.
 * @example
 * import { buildPathFromParams } from "@shadow-js/router/core";
 * buildPathFromParams("/users/:id", { id: "a b" }); // "/users/a%20b"
 * @since 1.0.0
 */
export function buildPathFromParams(
  pattern: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const parsed = parsePattern(pattern);
  const parts: string[] = [];
  let missingOptional = false;
  for (const segment of parsed.segments) {
    if (segment.kind === "static") {
      parts.push(segment.canonical);
      continue;
    }
    const value = Object.hasOwn(params, segment.name) ? params[segment.name] : undefined;
    if (value === undefined || value === "") {
      // The required splat never matches its own folder, so a link to it must carry a value.
      if (segment.kind === "optional") missingOptional = true;
      if (segment.kind === "optional" || (segment.kind === "splat" && segment.optional === true)) {
        continue;
      }
      throw new RangeError(
        __DEV__
          ? `missing required param "${segment.name}" for "${pattern}"`
          : "SHADOW_MISSING_PARAM",
      );
    }
    if (segment.kind === "optional" && missingOptional) {
      throw new RangeError(
        __DEV__
          ? `optional param "${segment.name}" cannot follow a missing optional param in "${pattern}"`
          : "SHADOW_OPTIONAL_AFTER_MISSING",
      );
    }
    for (const piece of segment.kind === "splat" ? value.split("/") : [value]) {
      if (piece === "") {
        throw new RangeError(
          __DEV__
            ? `splat "${segment.name}" has an empty piece in "${value}"`
            : "SHADOW_SPLAT_PIECE",
        );
      }
      parts.push(checkedPiece(piece, segment.name));
    }
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/** Encodes a param value, refusing the two that a URL parser would collapse (`.` and `..`, in any spelling). */
function checkedPiece(piece: string, name: string): string {
  if (piece === "." || piece === "..") {
    throw new RangeError(
      __DEV__
        ? `param "${name}" is "${piece}", a dot segment that the browser collapses; the link would go to another page`
        : "SHADOW_DOT_PARAM",
    );
  }
  return encodeSegment(piece);
}

/**
 * Resolves `to` against `from`, treating `from` as a directory: `edit` from `/posts/7` is
 * `/posts/7/edit`, `../list` from `/posts/7/comments` is `/posts/list`. A `to` that starts with `/`
 * replaces the path. `.` is skipped, `..` climbs and stops at the root. The query and hash of `to`
 * are kept. Pure text: no decoding, no pattern syntax (`:id` is an ordinary segment).
 *
 * @param from The base path, such as the current pathname or a route pattern.
 * @param to The relative (or absolute) path to resolve.
 * @returns The resolved path, starting with `/`.
 * @example resolvePath("/posts/7", "edit"); // "/posts/7/edit"
 * @since 1.0.0
 */
export function resolvePath(from: string, to: string): string {
  const hashAt = to.indexOf("#");
  const hash = hashAt < 0 ? "" : to.slice(hashAt);
  const beforeHash = hashAt < 0 ? to : to.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const query = queryAt < 0 ? "" : beforeHash.slice(queryAt);
  const target = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const out: string[] = target.startsWith("/")
    ? []
    : from.split("/").filter((piece) => piece !== "");
  for (const piece of target.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      out.pop();
      continue;
    }
    out.push(piece);
  }
  const trailing = target.endsWith("/") && out.length > 0 ? "/" : "";
  return `/${out.join("/")}${trailing}${query}${hash}`;
}
