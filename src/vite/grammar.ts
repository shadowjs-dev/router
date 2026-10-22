import type { RouteIssueCode } from "./issues";

/**
 * The file-name grammar of file routes. Pure: it looks at a path relative to the routes directory
 * and says what the file means, without touching the file system.
 *
 * | Name                | Meaning                                                  |
 * |---------------------|----------------------------------------------------------|
 * | `index.tsx`         | the index of its folder (empty segment)                  |
 * | `about.tsx`         | `/about`                                                 |
 * | `[id].tsx`          | `:id`                                                    |
 * | `[[lang]].tsx`      | `:lang?` (optional)                                      |
 * | `[...rest].tsx`     | `*rest` (splat: at least one segment; not the folder root) |
 * | `[[...rest]].tsx`   | `*rest?` (optional catch-all: the folder root too)       |
 * | `(group)/`          | no URL segment                                           |
 * | `_layout.tsx`       | layout of its folder, wraps siblings and children        |
 * | `_template.tsx`     | template of its folder: wraps like a layout, remounts on every navigation |
 * | `opengraph-image.tsx` | the Open Graph image of its folder, not a page (`metadataImageKindOf`)  |
 * | `twitter-image.tsx` | the Twitter image of its folder, not a page (`metadataImageKindOf`)          |
 * | `-name`, `.name`    | ignored (colocation)                                     |
 * | `[.]well-known`     | `.well-known` (a bracketed single punctuation character is literal) |
 */

/**
 * Script extensions that can hold a route.
 *
 * @example
 * import { ROUTE_EXTENSIONS } from "@shadow-js/router/vite";
 * ROUTE_EXTENSIONS.includes(".tsx"); // true
 * @since 1.0.0
 */
export const ROUTE_EXTENSIONS: readonly string[] = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"];

/** Why a file is not a route. @since 1.0.0 */
export type IgnoreReason =
  | "extension"
  | "dot-prefix"
  | "dash-prefix"
  | "declaration-file"
  | "test-file"
  | "generated-file";

/** What a path segment is. @since 1.0.0 */
export type SegmentKind = "static" | "param" | "optional" | "splat" | "group" | "index";

/** One directory or file name, interpreted. @since 1.0.0 */
export interface RouteSegment {
  /** The name as written on disk (without the file extension). */
  readonly source: string;
  readonly kind: SegmentKind;
  /** Pattern text (`posts`, `:id`, `:lang?`, `*rest`); empty for groups and index. */
  readonly pattern: string;
}

/** The meaning of one path under the routes directory. @since 1.0.0 */
export type RouteFileParse =
  | { readonly status: "ignored"; readonly reason: IgnoreReason }
  | { readonly status: "invalid"; readonly code: RouteIssueCode; readonly message: string }
  | {
      readonly status: "ok";
      /** True for `_layout.*`. */
      readonly layout: boolean;
      /**
       * True for `_template.*`. Present only then, so the parse of every other file is the shape it always was.
       * A template has no segment of its own either (`leaf` is `undefined`), and `layout` is false.
       */
      readonly template?: true;
      /** Directory segments, outermost first. */
      readonly dirs: readonly RouteSegment[];
      /** The file's own segment; `undefined` for a layout or a template. */
      readonly leaf: RouteSegment | undefined;
    };

/**
 * Normalizes a relative path: POSIX separators, no leading `./`.
 *
 * @example toPosix(".\\posts\\[id].tsx"); // "posts/[id].tsx"
 * @since 1.0.0
 */
export function toPosix(path: string): string {
  let out = path.replaceAll("\\", "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function extensionOf(name: string): string | undefined {
  for (const extension of ROUTE_EXTENSIONS) {
    if (name.endsWith(extension) && name.length > extension.length) return extension;
  }
  return undefined;
}

function isAsciiAlnum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/**
 * A param name, as the pattern grammar of `@shadow-js/router/core` accepts it.
 *
 * @example isParamName("userId"); // true; isParamName("user-id") is false
 * @since 1.0.0
 */
export function isParamName(name: string): boolean {
  if (name.length === 0) return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    const letter =
      (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
    if (!(letter || (index > 0 && code >= 0x30 && code <= 0x39))) return false;
  }
  return true;
}

type SegmentResult =
  | { readonly ok: true; readonly segment: RouteSegment }
  | { readonly ok: false; readonly code: RouteIssueCode; readonly message: string };

function fail(code: RouteIssueCode, message: string): SegmentResult {
  return { ok: false, code, message };
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Unwraps `[x]` escapes of one punctuation character; returns undefined on an unmatched bracket. */
function unescapeLiteral(name: string): string | undefined {
  let out = "";
  let index = 0;
  while (index < name.length) {
    const char = name.charAt(index);
    if (char === "[") {
      const inner = name.charAt(index + 1);
      const close = name.charAt(index + 2);
      if (inner !== "" && inner !== "[" && inner !== "]" && close === "]") {
        out += inner;
        index += 3;
        continue;
      }
      return undefined;
    }
    if (char === "]") return undefined;
    out += char;
    index += 1;
  }
  return out;
}

function isForbiddenLiteralChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return true;
  return (
    char === "%" ||
    char === "/" ||
    char === "\\" ||
    char === "?" ||
    char === "#" ||
    char === " " ||
    char === "\t" ||
    char === " " ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x3000
  );
}

function parseLiteral(source: string, text: string): SegmentResult {
  if (text.length === 0) {
    return fail("ROUTE_FILE_NAME_INVALID", `empty route segment "${source}"`);
  }
  if (hasLoneSurrogate(text)) {
    return fail("ROUTE_FILE_NAME_INVALID", `"${source}" contains a lone surrogate`);
  }
  for (const char of text) {
    if (isForbiddenLiteralChar(char)) {
      return fail(
        "ROUTE_FILE_NAME_INVALID",
        `"${source}" contains a character that cannot appear in a URL segment (%, whitespace, control characters, ? and #)`,
      );
    }
  }
  if (text === "." || text === "..") {
    return fail("ROUTE_FILE_NAME_INVALID", `"${source}" is not a valid route segment`);
  }
  const head = text.charAt(0);
  if (head === ":" || head === "*") {
    return fail(
      "ROUTE_FILE_NAME_INVALID",
      `"${source}" starts with "${head}", which is pattern syntax; write [name] for a param or [${head}] for a literal "${head}"`,
    );
  }
  return { ok: true, segment: { source, kind: "static", pattern: text } };
}

function parseSegment(
  rawName: string,
  options: { readonly directory: boolean; readonly allowSplat: boolean },
): SegmentResult {
  const source = rawName.normalize("NFC");
  // Parallel routes (`@slot` folders) and intercepting routes (`(.)x`, `(..)x`, `(...)x`) are not supported. Without
  // this check they would become literal URL segments.
  if (options.directory && /^@.+/.test(source)) {
    return fail(
      "ROUTE_PARALLEL_UNSUPPORTED",
      `"${source}" is a parallel-route folder (a name starting with @); fix: rename it to a plain folder, the router has no parallel routes`,
    );
  }
  if (/^\(\.{1,3}\)/.test(source)) {
    return fail(
      "ROUTE_INTERCEPT_UNSUPPORTED",
      `"${source}" is an intercepting route ((.), (..) or (...) prefix); fix: rename it, the router has no intercepting routes: give the page its own URL`,
    );
  }
  if (source.startsWith("(") && source.endsWith(")") && source.length > 2) {
    const inner = source.slice(1, -1);
    if (!options.directory) {
      return fail("ROUTE_GROUP_INVALID", `"${source}" is a group name; groups are folders`);
    }
    if (inner.includes("(") || inner.includes(")") || inner.includes("[") || inner.includes("]")) {
      return fail("ROUTE_GROUP_INVALID", `invalid group name "${source}"`);
    }
    for (const char of inner) {
      if (isForbiddenLiteralChar(char)) {
        return fail("ROUTE_GROUP_INVALID", `invalid group name "${source}"`);
      }
    }
    return { ok: true, segment: { source, kind: "group", pattern: "" } };
  }
  if (source === "()") return fail("ROUTE_GROUP_INVALID", `empty group name "${source}"`);

  if (source.startsWith("[") && source.endsWith("]")) {
    if (source.startsWith("[[") && source.endsWith("]]")) {
      const name = source.slice(2, -2);
      if (name.startsWith("...")) {
        // `[[...slug]]`: the optional catch-all. Like `[...rest]` it is a file name, never a folder.
        const splat = name.slice(3);
        if (!isParamName(splat)) {
          return fail("ROUTE_PARAM_INVALID", `illegal param name "${splat}" in "${source}"`);
        }
        if (!options.allowSplat) {
          return fail(
            "ROUTE_SPLAT_NOT_LAST",
            `"${source}" is an optional catch-all and must be the last segment, as a file name`,
          );
        }
        return { ok: true, segment: { source, kind: "splat", pattern: `*${splat}?` } };
      }
      if (!isParamName(name)) {
        return fail("ROUTE_PARAM_INVALID", `illegal param name "${name}" in "${source}"`);
      }
      return { ok: true, segment: { source, kind: "optional", pattern: `:${name}?` } };
    }
    if (source.startsWith("[...")) {
      const name = source.slice(4, -1);
      if (!isParamName(name)) {
        return fail("ROUTE_PARAM_INVALID", `illegal param name "${name}" in "${source}"`);
      }
      if (!options.allowSplat) {
        return fail(
          "ROUTE_SPLAT_NOT_LAST",
          `"${source}" is a splat and must be the last segment, as a file name`,
        );
      }
      return { ok: true, segment: { source, kind: "splat", pattern: `*${name}` } };
    }
    const name = source.slice(1, -1);
    const single = [...name].length === 1;
    const isEscape = single && !isAsciiAlnum(name.charCodeAt(0));
    if (!isEscape) {
      if (name.includes("[") || name.includes("]")) {
        return fail("ROUTE_BRACKET_UNMATCHED", `unmatched bracket in "${source}"`);
      }
      if (name === "") {
        return fail("ROUTE_BRACKET_UNMATCHED", `empty brackets in "${source}"`);
      }
      if (!isParamName(name)) {
        return fail("ROUTE_PARAM_INVALID", `illegal param name "${name}" in "${source}"`);
      }
      return { ok: true, segment: { source, kind: "param", pattern: `:${name}` } };
    }
  }

  const literal = unescapeLiteral(source);
  if (literal === undefined) {
    return fail("ROUTE_BRACKET_UNMATCHED", `unmatched bracket in "${source}"`);
  }
  return parseLiteral(source, literal);
}

/**
 * Interprets a path relative to the routes directory.
 *
 * @param relativePath Path such as `posts/[id].tsx`. Both `/` and `\` separate segments.
 * @returns The meaning of the file, or why it is ignored or invalid.
 * @example
 * parseRouteFile("posts/[id].tsx"); // { status: "ok", layout: false, dirs: [posts], leaf: [id] }
 * @since 1.0.0
 */
export function parseRouteFile(relativePath: string): RouteFileParse {
  const path = toPosix(relativePath);
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      return {
        status: "invalid",
        code: "ROUTE_FILE_NAME_INVALID",
        message: `"${relativePath}" is not a path inside the routes directory`,
      };
    }
  }
  for (const part of parts) {
    if (part.startsWith(".")) return { status: "ignored", reason: "dot-prefix" };
    if (part.startsWith("-")) return { status: "ignored", reason: "dash-prefix" };
  }
  const fileName = parts[parts.length - 1] ?? "";
  const extension = extensionOf(fileName);
  if (extension === undefined) return { status: "ignored", reason: "extension" };
  const stem = fileName.slice(0, -extension.length);
  if (stem.endsWith(".d") && (extension === ".ts" || extension === ".mts")) {
    return { status: "ignored", reason: "declaration-file" };
  }
  if (stem.endsWith(".test") || stem.endsWith(".spec")) {
    return { status: "ignored", reason: "test-file" };
  }
  if (stem.endsWith(".gen")) return { status: "ignored", reason: "generated-file" };

  const dirs: RouteSegment[] = [];
  for (const part of parts.slice(0, -1)) {
    const parsed = parseSegment(part, { directory: true, allowSplat: false });
    if (!parsed.ok) return { status: "invalid", code: parsed.code, message: parsed.message };
    dirs.push(parsed.segment);
  }
  if (stem === "_layout") return { status: "ok", layout: true, dirs, leaf: undefined };
  if (stem === "_template") {
    return { status: "ok", layout: false, template: true, dirs, leaf: undefined };
  }
  if (stem === "index") {
    return {
      status: "ok",
      layout: false,
      dirs,
      leaf: { source: "index", kind: "index", pattern: "" },
    };
  }
  const leaf = parseSegment(stem, { directory: false, allowSplat: true });
  if (!leaf.ok) return { status: "invalid", code: leaf.code, message: leaf.message };
  return { status: "ok", layout: false, dirs, leaf: leaf.segment };
}

/** The kind of a metadata image file: `opengraph-image` or `twitter-image`. @since 1.0.0 */
export type MetadataImageKind = "openGraph" | "twitter";

/**
 * The kind of metadata image a parsed route file is, or undefined for any other file. A file named `opengraph-image` or
 * `twitter-image` (any script extension, in any folder, a dynamic or group folder included) is not a page: it is the
 * image of its folder, served at the folder's URL plus its name. A layout, a template and an index file are never one.
 *
 * @param file The parse of the file (`parseRouteFile`), or the same fields of a scan candidate.
 * @returns The kind, or undefined.
 * @example metadataImageKindOf(parseRouteFile("blog/[slug]/opengraph-image.tsx")); // "openGraph"
 * @since 1.0.0
 */
export function metadataImageKindOf(file: {
  readonly layout: boolean;
  readonly template?: boolean | undefined;
  readonly leaf: RouteSegment | undefined;
}): MetadataImageKind | undefined {
  if (file.layout || file.template === true) return undefined;
  const leaf = file.leaf;
  if (leaf === undefined || leaf.kind !== "static") return undefined;
  if (leaf.source === "opengraph-image") return "openGraph";
  if (leaf.source === "twitter-image") return "twitter";
  return undefined;
}

/**
 * The URL pattern of segments: `/` plus the non-empty patterns.
 *
 * @example patternOf([posts, id]); // "/posts/:id"
 * @since 1.0.0
 */
export function patternOf(segments: readonly RouteSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) if (segment.pattern !== "") parts.push(segment.pattern);
  return `/${parts.join("/")}`;
}
