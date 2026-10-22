import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { findConflicts, isPrivatePattern, PatternSyntaxError, parsePattern } from "../core/index";
import { ModuleParseError } from "./ast";
import { dynamicParamsProblem } from "./dynamic-params";
import { analyzeRouteModule, type HttpMethod, type RouteModuleInfo } from "./exports";
import {
  type IgnoreReason,
  type MetadataImageKind,
  metadataImageKindOf,
  parseRouteFile,
  patternOf,
  type RouteSegment,
  toPosix,
} from "./grammar";
import { type RouteIssue, RouteScanError } from "./issues";

/**
 * Scans a routes directory into a route tree. The result is deterministic (sorted, independent of
 * directory listing order and of the machine), every problem is reported with the files involved,
 * and nothing outside the routes directory is ever read.
 */

/** Exports that make a script without a default export a route (a redirect-only page, say). */
const ROUTE_OPTION_EXPORTS: ReadonlySet<string> = new Set([
  "loader",
  "beforeLoad",
  "validateSearch",
  "loaderDeps",
  "head",
  "pending",
  "pendingMs",
  "error",
  "notFound",
  "tags",
  "staleReload",
  "metadata",
  "generateMetadata",
  "notFoundMetadata",
  "errorMetadata",
  "viewport",
  "generateViewport",
  "links",
  "meta",
  "headers",
  "ssr",
  "prerender",
  "revalidate",
  "cache",
  "middleware",
]);

/**
 * Segment exports of other frameworks that Dusk does not support, with what to use instead. A file that exports one
 * fails the scan: the export would otherwise be ignored and the page would not behave as written.
 */
const UNSUPPORTED_SEGMENT_EXPORTS: ReadonlyMap<string, string> = new Map([
  [
    "dynamic",
    "remove it; use revalidate or cache to say how long a response is reused, and ssr or prerender to say how it renders",
  ],
  ["runtime", "remove it; the platform adapter picks the runtime"],
  [
    "fetchCache",
    "remove it; use revalidate or cache for the response, and the data cache helpers for fetched data",
  ],
]);

/** File stem of a folder's middleware (`_middleware.ts`). Reserved: no route may be named this. */
const MIDDLEWARE_STEM = "_middleware";

/** File stem of the global error document (`_global-error.tsx`, at the routes root). Reserved, like `_middleware`. */
const GLOBAL_ERROR_STEM = "_global-error";

/** Exports that make a file a stream route (server-sent events, WebSocket). */
const STREAM_EXPORTS: readonly ("SSE" | "WS")[] = ["SSE", "WS"];

/**
 * Duplicate stream routes, and a stream route whose path a page or an API route also answers. Returns the
 * streams, one per path (the first by file).
 */
function checkStreams(
  streams: readonly StreamEntry[],
  pages: readonly { readonly id: string; readonly kind: string }[],
  apis: readonly ApiEntry[],
  report: (
    code: RouteIssue["code"],
    message: string,
    files: readonly string[],
    path?: string,
  ) => void,
): StreamEntry[] {
  const byId = new Map<string, StreamEntry[]>();
  for (const stream of streams) {
    const list = byId.get(stream.id) ?? [];
    list.push(stream);
    byId.set(stream.id, list);
  }
  const out: StreamEntry[] = [];
  for (const [id, list] of byId) {
    const first = list[0];
    if (first === undefined) continue;
    out.push(first);
    if (list.length > 1) {
      report(
        "ROUTE_DUPLICATE",
        `${list.length} files define the stream route "${id}"`,
        list.map((entry) => entry.file),
        id,
      );
    }
    const page = pages.some((entry) => entry.kind === "page" && entry.id === id);
    if (page || apis.some((entry) => entry.id === id)) {
      report(
        "ROUTE_DUPLICATE",
        `the stream route "${id}" has the same path as a page or an API route`,
        [first.file],
        id,
      );
    }
  }
  return out;
}

/** Directory names that are never scanned. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules"]);

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_FILES = 10_000;
const READ_CONCURRENCY = 32;
const CACHE_LIMIT = 5000;

/** A page, layout or template of the route tree. @since 1.0.0 */
export interface RouteEntry {
  /**
   * Route id. A page's id is its full URL pattern (`/posts/:id`); a layout's id is its folder
   * pattern plus `/_layout`, groups included (`/(auth)/_layout`); a template's is the folder
   * pattern plus `/_template`.
   */
  readonly id: string;
  /** A template is a pathless layout that remounts on navigation, so its kind is `"layout"`. */
  readonly kind: "page" | "layout";
  /**
   * True for a `_template` file; absent otherwise. A template sits inside the layout of its folder (when
   * there is one) and wraps the folder's pages and the folders below; it has no URL of its own.
   */
  readonly template?: true;
  /** File relative to the routes directory, POSIX separators. */
  readonly file: string;
  readonly absolutePath: string;
  /** The URL pattern this route sits at (a layout's is its folder prefix). */
  readonly fullPath: string;
  /**
   * True when the URL pattern has a `_`-prefixed static segment (a `_preview/` folder, a `_draft.tsx` file): the route is
   * private, so a request from outside never reaches it (see `isPrivatePattern`).
   */
  readonly private: boolean;
  /** Path relative to the parent route; empty for an index page or a pathless layout. */
  readonly path: string;
  readonly parentId: string | undefined;
  readonly info: RouteModuleInfo;
  /** Child routes sorted by file. A page has none. */
  readonly children: readonly RouteEntry[];
  /** False when the route has nothing a router can match (a layout with children). */
  readonly isEndpoint: boolean;
}

/** A file-based API route. @since 1.0.0 */
export interface ApiEntry {
  /** The URL pattern. */
  readonly id: string;
  readonly file: string;
  readonly absolutePath: string;
  readonly fullPath: string;
  readonly methods: readonly HttpMethod[];
  /** True when the module exports `matchFilters`: the rules are read at startup, so the manifest carries them. */
  readonly matchFilters: boolean;
  /** True when the URL pattern is private (see {@link RouteEntry.private}). */
  readonly private: boolean;
}

/**
 * A file that exports `SSE` and/or `WS`: a stream route, answered by the server runtime (not a page and not
 * an API route). It is not in the generated route tree.
 * @since 1.0.0
 */
export interface StreamEntry {
  /** The URL pattern. */
  readonly id: string;
  readonly file: string;
  readonly absolutePath: string;
  readonly fullPath: string;
  /** Which handlers the module exports, in the order of the file. */
  readonly kinds: readonly ("SSE" | "WS")[];
  /** True when the URL pattern is private (see {@link RouteEntry.private}). */
  readonly private: boolean;
}

/**
 * A `_middleware` file: its middleware applies to every page and API route beneath its folder. It is
 * not a route and has no URL of its own.
 * @since 1.0.0
 */
export interface MiddlewareEntry {
  /** File relative to the routes directory, POSIX separators (`admin/_middleware.ts`). */
  readonly file: string;
  readonly absolutePath: string;
  /** The folder the file sits in, relative to the routes directory (`""` for the routes root). */
  readonly folder: string;
}

/**
 * The global error file (`_global-error.tsx` at the routes root): the document an app answers when it fails to render
 * above the routes. It is not a route and has no URL.
 * @since 1.0.0
 */
export interface GlobalErrorEntry {
  /** File relative to the routes directory, POSIX separators. */
  readonly file: string;
  readonly absolutePath: string;
}

/**
 * A metadata image file: `opengraph-image` or `twitter-image` (any script extension) in a route folder. It is not a page,
 * an API route or a stream route; its route is the folder URL plus the file name (the image convention of Dusk).
 * @since 1.0.0
 */
export interface MetadataImageFile {
  /** File relative to the routes directory, POSIX separators (`blog/[slug]/opengraph-image.tsx`). */
  readonly file: string;
  readonly absolutePath: string;
  readonly kind: MetadataImageKind;
  /** The folder the file sits in, relative to the routes directory (`""` for the routes root). */
  readonly folder: string;
}

/** A file the scanner skipped. @since 1.0.0 */
export interface IgnoredFile {
  readonly file: string;
  readonly reason: IgnoreReason | "outside-root" | "symlink-loop";
}

/** The outcome of {@link scanRoutes}. @since 1.0.0 */
export interface ScanResult {
  readonly routesDir: string;
  /** Top-level routes (pages and layouts without a parent layout), sorted by file. */
  readonly roots: readonly RouteEntry[];
  /** Every page and layout in tree pre-order. */
  readonly entries: readonly RouteEntry[];
  /** API routes sorted by file. */
  readonly api: readonly ApiEntry[];
  /** Stream routes (`SSE` and `WS` exports) sorted by file. */
  readonly streams: readonly StreamEntry[];
  /** `_middleware` files, sorted by file. Not routes: they run for everything beneath their folder. */
  readonly middleware: readonly MiddlewareEntry[];
  /** The global error file, when the routes root has one. Not a route. */
  readonly globalError?: GlobalErrorEntry;
  /** `opengraph-image` and `twitter-image` files, sorted by file. Not routes: they carry the images of their folder. */
  readonly metadataImages: readonly MetadataImageFile[];
  readonly ignored: readonly IgnoredFile[];
  /** Every route file that was read, sorted. */
  readonly files: readonly string[];
}

/**
 * Memory of analyzed modules by content hash, so unchanged files are not parsed again.
 *
 * @internal
 * @since 1.0.0
 */
export type ScanCache = Map<string, RouteModuleInfo>;

/** Options of {@link scanRoutes}. @since 1.0.0 */
export interface ScanOptions {
  /** Absolute path of the routes directory. */
  readonly routesDir: string;
  /** Static segments compare ASCII case exactly. Default false (the router's default). */
  readonly caseSensitive?: boolean;
  /** URL prefixes no route may use. Default `["/_dusk"]` (the server-function endpoint). */
  readonly reservedPrefixes?: readonly string[];
  /** Maximum folder depth below the routes directory. Default 32. */
  readonly maxDepth?: number;
  /** Maximum number of route files. Default 10 000. */
  readonly maxFiles?: number;
  /** Reuse analysis of unchanged files across scans. */
  readonly cache?: ScanCache;
  /** Treat a missing routes directory as an empty one instead of failing. Default false. */
  readonly allowMissing?: boolean;
}

interface Candidate {
  readonly file: string;
  /** The path under the routes directory as given (symlinks not resolved): what imports use. */
  readonly absolutePath: string;
  /** Where the bytes are read from (a symlink's target stays inside the routes directory). */
  readonly readPath: string;
  readonly dirs: readonly RouteSegment[];
  readonly leaf: RouteSegment | undefined;
  readonly layout: boolean;
  /** True for `_template.*`. */
  readonly template: boolean;
}

interface MutableEntry {
  readonly id: string;
  readonly kind: "page" | "layout";
  /** True for a template (kind `"layout"`). */
  readonly template: boolean;
  readonly file: string;
  readonly absolutePath: string;
  readonly fullPath: string;
  readonly dirs: readonly RouteSegment[];
  readonly leaf: RouteSegment | undefined;
  readonly info: RouteModuleInfo;
  parent: MutableEntry | undefined;
  path: string;
  children: MutableEntry[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function dirKey(dirs: readonly RouteSegment[]): string {
  if (dirs.length === 0) return "/";
  return `/${dirs.map((dir) => (dir.kind === "group" ? dir.source : dir.pattern)).join("/")}`;
}

/** Walks the routes directory. Iterative; symlinks are followed only inside the directory. */
async function walk(
  root: string,
  logicalRoot: string,
  options: { readonly maxDepth: number; readonly maxFiles: number },
  issues: RouteIssue[],
  ignored: IgnoredFile[],
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const visitedDirs = new Set<string>([root]);
  const stack: { readonly directory: string; readonly rel: string; readonly depth: number }[] = [
    { directory: root, rel: "", depth: 0 },
  ];
  let count = 0;
  let limitReported = false;
  const report = (code: RouteIssue["code"], message: string, files: readonly string[]): void => {
    issues.push({ code, message, files: [...files].sort(compare) });
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let dirents: Dirent[];
    try {
      dirents = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      // A folder removed while the scan runs is simply gone; the next scan sees the final state.
      if (current.depth > 0 && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    dirents.sort((a, b) => compare(a.name, b.name));
    // Pushed in reverse so directories pop in sorted order; files are handled right away.
    const pending: typeof stack = [];
    for (const dirent of dirents) {
      const name = dirent.name;
      const rel = current.rel === "" ? name : `${current.rel}/${name}`;
      const absolutePath = join(current.directory, name);
      if (name.startsWith(".") || name.startsWith("-") || SKIPPED_DIRECTORIES.has(name)) {
        if (!dirent.isDirectory()) {
          ignored.push({ file: rel, reason: name.startsWith(".") ? "dot-prefix" : "dash-prefix" });
        }
        continue;
      }
      let isDirectory = dirent.isDirectory();
      let isFile = dirent.isFile();
      let resolved = absolutePath;
      if (dirent.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(absolutePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            ignored.push({ file: rel, reason: "outside-root" });
            continue;
          }
          throw error;
        }
        if (!isInside(root, target)) {
          ignored.push({ file: rel, reason: "outside-root" });
          continue;
        }
        resolved = target;
        const info = await stat(target);
        isDirectory = info.isDirectory();
        isFile = info.isFile();
        if (isDirectory && visitedDirs.has(target)) {
          ignored.push({ file: rel, reason: "symlink-loop" });
          continue;
        }
      }
      if (isDirectory) {
        if (current.depth + 1 > options.maxDepth) {
          if (!limitReported) {
            report("ROUTE_LIMIT", `routes are nested deeper than ${options.maxDepth} folders`, [
              rel,
            ]);
            limitReported = true;
          }
          continue;
        }
        visitedDirs.add(resolved);
        pending.push({ directory: resolved, rel, depth: current.depth + 1 });
        continue;
      }
      if (!isFile) continue;
      const parsed = parseRouteFile(rel);
      if (parsed.status === "ignored") {
        ignored.push({ file: rel, reason: parsed.reason });
        continue;
      }
      if (parsed.status === "invalid") {
        report(parsed.code, parsed.message, [rel]);
        continue;
      }
      count += 1;
      if (count > options.maxFiles) {
        if (!limitReported) {
          report("ROUTE_LIMIT", `more than ${options.maxFiles} route files`, [rel]);
          limitReported = true;
        }
        continue;
      }
      candidates.push({
        file: rel,
        absolutePath: join(logicalRoot, ...rel.split("/")),
        readPath: resolved,
        dirs: parsed.dirs,
        leaf: parsed.leaf,
        layout: parsed.layout,
        template: parsed.template === true,
      });
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index];
      if (item !== undefined) stack.push(item);
    }
  }
  return candidates;
}

async function analyzeAll(
  candidates: readonly Candidate[],
  cache: ScanCache,
  issues: RouteIssue[],
): Promise<Map<string, RouteModuleInfo>> {
  const infos = new Map<string, RouteModuleInfo>();
  for (let from = 0; from < candidates.length; from += READ_CONCURRENCY) {
    const batch = candidates.slice(from, from + READ_CONCURRENCY);
    const read = await Promise.all(
      batch.map(async (candidate) => {
        try {
          return { candidate, text: await readFile(candidate.readPath, "utf8") };
        } catch (error) {
          // A file removed while the scan runs is gone: the next scan sees the final state.
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { candidate, text: undefined };
          throw error;
        }
      }),
    );
    for (const { candidate, text } of read) {
      if (text === undefined) continue;
      const key = createHash("sha1")
        .update(`${extname(candidate.absolutePath)}\u0000`)
        .update(text)
        .digest("hex");
      const cached = cache.get(key);
      if (cached !== undefined) {
        infos.set(candidate.file, cached);
        continue;
      }
      try {
        const info = analyzeRouteModule(text, candidate.absolutePath);
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(key, info);
        infos.set(candidate.file, info);
      } catch (error) {
        if (error instanceof ModuleParseError) {
          issues.push({
            code: "ROUTE_PARSE_ERROR",
            message: `${candidate.file}:${error.line}:${error.column}: syntax error\n${error.frame}`,
            files: [candidate.file],
          });
          continue;
        }
        throw error;
      }
    }
  }
  return infos;
}

function mergeIssues(issues: readonly RouteIssue[]): RouteIssue[] {
  const merged = new Map<string, RouteIssue>();
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.message}\u0000${issue.path ?? ""}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, issue);
      continue;
    }
    const files = [...new Set([...existing.files, ...issue.files])].sort(compare);
    merged.set(key, { ...existing, files });
  }
  return [...merged.values()].sort(
    (a, b) =>
      compare(a.code, b.code) ||
      compare(a.files[0] ?? "", b.files[0] ?? "") ||
      compare(a.message, b.message),
  );
}

function normalizedKey(pattern: string, caseSensitive: boolean): string {
  if (caseSensitive) return pattern;
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const code = pattern.charCodeAt(index);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : pattern.charAt(index);
  }
  return out;
}

/**
 * Scans a routes directory.
 *
 * @param options See {@link ScanOptions}.
 * @returns The route tree, API routes and ignored files.
 * @throws RouteScanError listing every problem with its files: invalid names, duplicate or
 *   ambiguous paths, a page and an API route answering the same method, mixed exports.
 * @example
 * const scan = await scanRoutes({ routesDir: "/app/src/routes" });
 * scan.entries.map((entry) => entry.id); // ["/", "/posts", "/posts/:id"]
 * @since 1.0.0
 */
export async function scanRoutes(options: ScanOptions): Promise<ScanResult> {
  const caseSensitive = options.caseSensitive ?? false;
  const reserved = options.reservedPrefixes ?? ["/_dusk"];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const cache: ScanCache = options.cache ?? new Map<string, RouteModuleInfo>();
  const issues: RouteIssue[] = [];
  const ignored: IgnoredFile[] = [];
  let root: string;
  try {
    root = await realpath(options.routesDir);
  } catch (error) {
    if (options.allowMissing === true && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        routesDir: options.routesDir,
        roots: [],
        entries: [],
        api: [],
        streams: [],
        middleware: [],
        metadataImages: [],
        ignored: [],
        files: [],
      };
    }
    throw error;
  }

  const walked = await walk(root, options.routesDir, { maxDepth, maxFiles }, issues, ignored);
  // `_middleware` files are not routes: they are kept apart and never analyzed as modules.
  const middlewareCandidates = walked.filter((candidate) => isMiddlewareFile(candidate));
  const globalErrorCandidates = walked.filter((candidate) => isGlobalErrorFile(candidate));
  // A metadata image is a file of its folder, never a page: `blog/[slug]/opengraph-image.tsx` is not `/blog/:slug/...`.
  const metadataCandidates = walked.filter(
    (candidate) => metadataImageKindOf(candidate) !== undefined,
  );
  const candidates = walked.filter(
    (candidate) =>
      !isMiddlewareFile(candidate) &&
      !isGlobalErrorFile(candidate) &&
      metadataImageKindOf(candidate) === undefined,
  );
  candidates.sort((a, b) => compare(a.file, b.file));
  const infos = await analyzeAll(candidates, cache, issues);

  const pages: MutableEntry[] = [];
  const api: ApiEntry[] = [];
  const streams: StreamEntry[] = [];
  const reportIssue = (
    code: RouteIssue["code"],
    message: string,
    files: readonly string[],
    path?: string,
  ): void => {
    issues.push({
      code,
      message,
      files: [...files].sort(compare),
      ...(path === undefined ? {} : { path }),
    });
  };

  for (const candidate of candidates) {
    const info = infos.get(candidate.file);
    if (info === undefined) continue;
    // A layout and a template are both folder wrappers: neither is a page, an API route or a stream route.
    const container = candidate.layout || candidate.template;
    const containerName = candidate.template ? "template" : "layout";
    const segments =
      candidate.leaf === undefined ? candidate.dirs : [...candidate.dirs, candidate.leaf];
    const fullPath = patternOf(segments);
    try {
      parsePattern(fullPath);
    } catch (error) {
      if (error instanceof PatternSyntaxError) {
        reportIssue(
          "ROUTE_PATTERN_INVALID",
          `${error.message} (from "${candidate.file}")`,
          [candidate.file],
          fullPath,
        );
        continue;
      }
      throw error;
    }
    const key = normalizedKey(fullPath, false);
    const hit = reserved.find((prefix) => {
      const lowered = normalizedKey(prefix, false);
      return key === lowered || key.startsWith(`${lowered}/`);
    });
    if (hit !== undefined) {
      reportIssue(
        "ROUTE_RESERVED_PREFIX",
        `"${fullPath}" uses the reserved prefix "${hit}"`,
        [candidate.file],
        fullPath,
      );
      continue;
    }

    // A private route (a `_`-prefixed folder or file) is not a public URL: it can never be prerendered, because the
    // static output would publish it.
    const isPrivate = isPrivatePattern(fullPath);
    if (isPrivate && info.exports.includes("prerender")) {
      reportIssue(
        "ROUTE_PRIVATE_PRERENDER",
        `"${fullPath}" is private (a "_" segment) and exports prerender: a prerendered page is published as a static file; fix: remove the prerender export, or move the file out of the "_" folder`,
        [candidate.file],
        fullPath,
      );
      continue;
    }

    // An export Dusk does not support would be ignored without a word: fail the build instead, with what to use.
    const unsupported = info.exports.filter((name) => UNSUPPORTED_SEGMENT_EXPORTS.has(name));
    if (unsupported.length > 0) {
      reportIssue(
        "ROUTE_EXPORT_UNSUPPORTED",
        unsupported
          .map(
            (name) =>
              `exports "${name}", which Dusk does not support; fix: ${UNSUPPORTED_SEGMENT_EXPORTS.get(name)}`,
          )
          .join("; "),
        [candidate.file],
        fullPath,
      );
      continue;
    }

    // `dynamicParams` is supported, but only as a literal on a page that lists its params (see dynamic-params.ts).
    const dynamicParamsIssue = dynamicParamsProblem(info, {
      ...(container ? { wrapper: containerName } : {}),
      fullPath,
      endpoint:
        info.methods.length > 0 ||
        info.defaultApi !== undefined ||
        STREAM_EXPORTS.some((name) => info.exports.includes(name)),
    });
    if (dynamicParamsIssue !== undefined) {
      reportIssue("ROUTE_DYNAMIC_PARAMS_INVALID", dynamicParamsIssue, [candidate.file], fullPath);
      continue;
    }

    const streamExports = STREAM_EXPORTS.filter((name) => info.exports.includes(name));
    if (streamExports.length > 0) {
      const apiMethods = info.methods.length > 0 || info.defaultApi !== undefined;
      if (container || info.hasDefault || apiMethods) {
        reportIssue(
          "ROUTE_MIXED_EXPORTS",
          `exports ${streamExports.join(" and ")} (a stream route) and ${
            container
              ? `is a ${containerName}`
              : info.hasDefault
                ? "a default component"
                : "HTTP method handlers"
          }; a file is a page, an API route or a stream route`,
          [candidate.file],
          fullPath,
        );
        continue;
      }
      streams.push({
        id: fullPath,
        file: candidate.file,
        absolutePath: candidate.absolutePath,
        fullPath,
        kinds: streamExports,
        private: isPrivate,
      });
      continue;
    }

    const defaultApi = info.defaultApi;
    if (info.methods.length > 0 || defaultApi !== undefined) {
      const named = info.methods.length > 0;
      if (
        container ||
        (defaultApi !== undefined && named) ||
        (defaultApi === undefined && info.hasDefault)
      ) {
        const reason = container
          ? `is a ${containerName}`
          : defaultApi !== undefined
            ? "a default apiRoute()"
            : "a default component";
        reportIssue(
          "ROUTE_MIXED_EXPORTS",
          `exports ${
            named ? `HTTP method handlers (${info.methods.join(", ")})` : "a default apiRoute()"
          } and ${reason}; a file is either a page or an API route`,
          [candidate.file],
          fullPath,
        );
        continue;
      }
      if (defaultApi !== undefined && (!defaultApi.readable || defaultApi.methods.length === 0)) {
        reportIssue(
          "ROUTE_API_NOT_READABLE",
          defaultApi.readable
            ? "the default export apiRoute({...}) has no HTTP method (GET, POST, ...); add a handler"
            : "the scanner cannot read the methods of the default export apiRoute(...): pass it an object literal with plain method names (apiRoute({ GET, POST })), or export the methods by name (export const { GET } = apiRoute({ ... }))",
          [candidate.file],
          fullPath,
        );
        continue;
      }
      api.push({
        id: fullPath,
        file: candidate.file,
        absolutePath: candidate.absolutePath,
        fullPath,
        methods: defaultApi === undefined ? info.methods : defaultApi.methods,
        matchFilters: info.exports.includes("matchFilters"),
        private: isPrivate,
      });
      continue;
    }
    // A template is the component that wraps its folder; without one it would wrap nothing.
    if (candidate.template && !info.hasDefault) {
      reportIssue(
        "ROUTE_NO_EXPORTS",
        "is a template and has no default export; fix: export the component that wraps the folder, for example export default function Template() { return <Outlet />; }",
        [candidate.file],
        fullPath,
      );
      continue;
    }
    const usable =
      info.hasDefault ||
      info.hasStarExport ||
      info.exports.some((name) => ROUTE_OPTION_EXPORTS.has(name));
    if (!usable) {
      reportIssue(
        "ROUTE_NO_EXPORTS",
        'has no default export, no route options and no HTTP method handlers; rename it with a leading "-" if it is not a route',
        [candidate.file],
        fullPath,
      );
      continue;
    }
    const kind = container ? "layout" : "page";
    const id =
      kind === "page"
        ? fullPath
        : `${dirKey(candidate.dirs) === "/" ? "" : dirKey(candidate.dirs)}/_${containerName}`;
    pages.push({
      id,
      kind,
      template: candidate.template,
      file: candidate.file,
      absolutePath: candidate.absolutePath,
      fullPath,
      dirs: candidate.dirs,
      leaf: candidate.leaf,
      info,
      parent: undefined,
      path: "",
      children: [],
    });
  }

  // Exact duplicates first (they would share a route id), then structural ambiguity.
  const byId = new Map<string, MutableEntry[]>();
  for (const entry of pages) {
    const list = byId.get(entry.id) ?? [];
    list.push(entry);
    byId.set(entry.id, list);
  }
  const unique: MutableEntry[] = [];
  for (const [id, list] of byId) {
    const first = list[0];
    if (first === undefined) continue;
    unique.push(first);
    if (list.length > 1) {
      reportIssue(
        "ROUTE_DUPLICATE",
        `${list.length} files map to the same ${first.kind === "page" ? "route" : first.template ? "template" : "layout"} "${id}"; fix: keep one of these files, or move one of them to a folder whose URL differs`,
        list.map((entry) => entry.file),
        first.fullPath,
      );
    }
  }
  const apiById = new Map<string, ApiEntry[]>();
  for (const entry of api) {
    const list = apiById.get(entry.id) ?? [];
    list.push(entry);
    apiById.set(entry.id, list);
  }
  const uniqueApi: ApiEntry[] = [];
  for (const [id, list] of apiById) {
    const first = list[0];
    if (first === undefined) continue;
    uniqueApi.push(first);
    if (list.length > 1) {
      reportIssue(
        "ROUTE_DUPLICATE",
        `${list.length} files define the API route "${id}"`,
        list.map((entry) => entry.file),
        id,
      );
    }
  }

  // Layout, template and parent resolution. A folder's template sits inside its layout (layout > template >
  // pages), so a page takes the template as its parent when the folder has one, and the template takes the layout.
  const wrappers = new Map<string, { layout?: MutableEntry; template?: MutableEntry }>();
  for (const entry of unique) {
    if (entry.kind !== "layout") continue;
    const key = dirKey(entry.dirs);
    const folder = wrappers.get(key) ?? {};
    if (entry.template) folder.template = entry;
    else folder.layout = entry;
    wrappers.set(key, folder);
  }
  /** The innermost wrapper at `length` folders deep or above. */
  const enclosing = (
    dirs: readonly RouteSegment[],
    fromLength: number,
  ): MutableEntry | undefined => {
    for (let length = fromLength; length >= 0; length -= 1) {
      const folder = wrappers.get(dirKey(dirs.slice(0, length)));
      const found = folder?.template ?? folder?.layout;
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const entry of unique) {
    const parent = entry.template
      ? (wrappers.get(dirKey(entry.dirs))?.layout ?? enclosing(entry.dirs, entry.dirs.length - 1))
      : enclosing(entry.dirs, entry.kind === "layout" ? entry.dirs.length - 1 : entry.dirs.length);
    entry.parent = parent;
    const offset = parent === undefined ? 0 : parent.dirs.length;
    const own = entry.dirs.slice(offset);
    if (entry.kind === "page" && entry.leaf !== undefined) own.push(entry.leaf);
    const relativePattern = patternOf(own);
    entry.path = relativePattern === "/" ? "" : relativePattern;
    if (parent !== undefined) parent.children.push(entry);
  }
  for (const entry of unique) entry.children.sort((a, b) => compare(a.file, b.file));

  // A template with nothing under it wraps nothing: it is not a route (its file is still watched through `files`).
  // Dropping one can empty the template above it, so this repeats until no more go.
  const dropped = new Set<MutableEntry>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of unique) {
      if (!entry.template || dropped.has(entry)) continue;
      if (entry.children.every((child) => dropped.has(child))) {
        dropped.add(entry);
        changed = true;
      }
    }
  }
  const kept = dropped.size === 0 ? unique : unique.filter((entry) => !dropped.has(entry));
  if (dropped.size > 0) {
    for (const entry of kept)
      entry.children = entry.children.filter((child) => !dropped.has(child));
  }

  // Ambiguity among endpoints (pages, childless layouts) and API routes, on full URL patterns.
  const endpoints = kept.filter((entry) => entry.kind === "page" || entry.children.length === 0);
  const files = new Map<string, string>();
  const definitions: { id: string; path: string }[] = [];
  for (const entry of endpoints) {
    files.set(`page:${entry.id}`, entry.file);
    definitions.push({ id: `page:${entry.id}`, path: entry.fullPath });
  }
  for (const entry of uniqueApi) {
    files.set(`api:${entry.id}`, entry.file);
    definitions.push({ id: `api:${entry.id}`, path: entry.fullPath });
  }
  const reportedPairs = new Set<string>();
  try {
    for (const conflict of findConflicts(definitions, { caseSensitive })) {
      if (conflict.kind !== "ambiguous-path") continue;
      const [first, second] = conflict.ids;
      const firstFile = files.get(first);
      const secondFile = files.get(second);
      if (firstFile === undefined || secondFile === undefined) continue;
      // One report per pair of files, even when several optional variants overlap.
      const pair = `${first}\u0000${second}`;
      if (reportedPairs.has(pair)) continue;
      reportedPairs.add(pair);
      const firstIsApi = first.startsWith("api:");
      const secondIsApi = second.startsWith("api:");
      if (firstIsApi !== secondIsApi) {
        const apiEntry = uniqueApi.find(
          (entry) => `api:${entry.id}` === (firstIsApi ? first : second),
        );
        // `ALL` answers GET and HEAD too (unless they are exported by name), so it claims them.
        const methods: readonly string[] = apiEntry?.methods ?? [];
        const answered: readonly string[] = methods.includes("ALL") ? ["GET", "HEAD"] : methods;
        const claimed = answered.filter((m) => m === "GET" || m === "HEAD");
        if (claimed.length === 0) continue;
        reportIssue(
          "ROUTE_PAGE_API_CONFLICT",
          `a page and an API route both answer ${claimed.join(", ")} for "${conflict.pattern}"`,
          [firstFile, secondFile],
          conflict.pattern,
        );
        continue;
      }
      reportIssue(
        "ROUTE_AMBIGUOUS",
        `these ${firstIsApi ? "API routes" : "routes"} match the same URLs (param names and letter case do not tell them apart); fix: keep one of the files, or give one of them a static segment or an index file so the two no longer match the same URLs`,
        [firstFile, secondFile],
        conflict.pattern,
      );
    }
  } catch (error) {
    if (error instanceof PatternSyntaxError) {
      reportIssue("ROUTE_PATTERN_INVALID", error.message, []);
    } else {
      throw error;
    }
  }

  const streamRoutes = checkStreams(streams, kept, uniqueApi, reportIssue);
  const [globalErrorFirst, ...globalErrorOthers] = globalErrorCandidates;
  if (globalErrorOthers.length > 0) {
    reportIssue(
      "ROUTE_DUPLICATE",
      `${globalErrorCandidates.length} files are the global error: keep one of "_global-error.(tsx|ts|jsx|js)" at the routes root`,
      globalErrorCandidates.map((candidate) => candidate.file),
    );
  }
  const merged = mergeIssues(issues);
  if (merged.length > 0) throw new RouteScanError(merged);

  // Freeze into the public shape, in pre-order.
  const built = new Map<MutableEntry, RouteEntry>();
  const toEntry = (entry: MutableEntry): RouteEntry => {
    const existing = built.get(entry);
    if (existing !== undefined) return existing;
    const children = entry.children.map(toEntry);
    const result: RouteEntry = {
      id: entry.id,
      kind: entry.kind,
      ...(entry.template ? { template: true as const } : {}),
      file: entry.file,
      absolutePath: entry.absolutePath,
      fullPath: entry.fullPath,
      private: isPrivatePattern(entry.fullPath),
      path: entry.path,
      parentId: entry.parent?.id,
      info: entry.info,
      children,
      isEndpoint: entry.kind === "page" || children.length === 0,
    };
    built.set(entry, result);
    return result;
  };
  const roots = kept
    .filter((entry) => entry.parent === undefined)
    .sort((a, b) => compare(a.file, b.file))
    .map(toEntry);
  const entries: RouteEntry[] = [];
  const stack: RouteEntry[] = [...roots].reverse();
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    entries.push(next);
    for (let index = next.children.length - 1; index >= 0; index -= 1) {
      const child = next.children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return {
    routesDir: options.routesDir,
    roots,
    entries,
    api: uniqueApi.sort((a, b) => compare(a.file, b.file)),
    streams: streamRoutes.sort((a, b) => compare(a.file, b.file)),
    ...(globalErrorFirst === undefined
      ? {}
      : {
          globalError: { file: globalErrorFirst.file, absolutePath: globalErrorFirst.absolutePath },
        }),
    middleware: middlewareCandidates
      .map((candidate) => ({
        file: candidate.file,
        absolutePath: candidate.absolutePath,
        folder: candidate.file.includes("/")
          ? candidate.file.slice(0, candidate.file.lastIndexOf("/"))
          : "",
      }))
      .sort((a, b) => compare(a.file, b.file)),
    metadataImages: metadataCandidates
      .map((candidate) => ({
        file: candidate.file,
        absolutePath: candidate.absolutePath,
        kind: metadataImageKindOf(candidate) ?? "openGraph",
        folder: folderOfFile(candidate.file),
      }))
      .sort((a, b) => compare(a.file, b.file)),
    ignored: ignored.sort((a, b) => compare(a.file, b.file)),
    files: [...candidates, ...middlewareCandidates, ...globalErrorCandidates, ...metadataCandidates]
      .map((candidate) => candidate.file)
      .sort(compare),
  };
}

/** The folder of a POSIX file path relative to the routes directory; empty for the root. */
function folderOfFile(file: string): string {
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
}

/** True for a `_middleware` file (any folder, any script extension). */
function isMiddlewareFile(candidate: Candidate): boolean {
  return !candidate.layout && candidate.leaf?.source === MIDDLEWARE_STEM;
}

/** True for the global error file: `_global-error` directly in the routes root (any script extension). */
function isGlobalErrorFile(candidate: Candidate): boolean {
  return (
    !candidate.layout && candidate.dirs.length === 0 && candidate.leaf?.source === GLOBAL_ERROR_STEM
  );
}

/**
 * Converts a path with the platform separator to the POSIX form used in scan results.
 *
 * @internal
 * @example toRouteFile("/app/src/routes", "/app/src/routes/posts/[id].tsx"); // "posts/[id].tsx"
 * @since 1.0.0
 */
export function toRouteFile(routesDir: string, absolutePath: string): string {
  return toPosix(relative(routesDir, absolutePath).split(sep).join("/"));
}
