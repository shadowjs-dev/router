import type { RouteCacheOptions } from "../types";
import {
  type AstNode,
  identifierName,
  isNode,
  moduleExportName,
  nodesAt,
  parseModule,
  patternNames,
  stringValue,
  unwrapExpression,
} from "./ast";

/**
 * HTTP methods a file can export to become an API route.
 * @example
 * import { HTTP_METHODS } from "@shadow-js/router/vite";
 * HTTP_METHODS.includes("POST"); // true
 * @since 1.0.0
 */
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
] as const;

/** One of {@link HTTP_METHODS}. @since 1.0.0 */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Route options that are plain literals in the source, read without running the module.
 *
 * @since 1.0.0
 */
export interface RouteConfigLiterals {
  /** `export const ssr = false` or `"data-only"`. */
  readonly ssr?: boolean | "data-only";
  /** `export const prerender = true`, or a literal list of paths. */
  readonly prerender?: boolean | readonly string[];
  /** `export const revalidate = 60` (seconds) or `false`: how long the ISR cache keeps a page. */
  readonly revalidate?: number | false;
  /** `export const cache = { staleSeconds, cookies, searchParams }`, literal values only. */
  readonly cache?: RouteCacheOptions;
  /**
   * `export const dynamicParams = true | false`. Absent means `true`: a param the `prerender` export does not list
   * renders on request. `false`: such a param is not found.
   */
  readonly dynamicParams?: boolean;
}

/**
 * A default export of `apiRoute({...})` from `@shadow-js/dusk/server`, read without running the
 * module. Such a file is an API route, not a page.
 *
 * @since 1.0.0
 */
export interface DefaultApiRoute {
  /** The HTTP methods of the object literal, in the order of {@link HTTP_METHODS}. */
  readonly methods: readonly HttpMethod[];
  /**
   * False when the methods cannot be read from the source: the argument is not an object literal,
   * or it has a spread or a computed key.
   */
  readonly readable: boolean;
}

/** What a route module exports, found statically. @since 1.0.0 */
export interface RouteModuleInfo {
  /** True when there is a default export. */
  readonly hasDefault: boolean;
  /** Runtime export names, sorted, without type-only exports. Includes `default`. */
  readonly exports: readonly string[];
  /** HTTP-method exports by name, in the order of {@link HTTP_METHODS}. */
  readonly methods: readonly HttpMethod[];
  /**
   * Set when the default export is `apiRoute({...})` imported from `@shadow-js/dusk/server`
   * (directly, through a local `const`, or as `export { x as default }`).
   */
  readonly defaultApi: DefaultApiRoute | undefined;
  /** True when the module has an `export * from`: the full export list is not known. */
  readonly hasStarExport: boolean;
  readonly config: RouteConfigLiterals;
}

const METHOD_SET: ReadonlySet<string> = new Set<string>(HTTP_METHODS);

function isHttpMethod(name: string): name is HttpMethod {
  return METHOD_SET.has(name);
}

/** The module whose `apiRoute` makes a default export an API route. */
const API_ROUTE_MODULE = "@shadow-js/dusk/server";

/** Local names bound to `apiRoute` (and namespaces that hold it) by the module's imports. */
interface ApiRouteBindings {
  readonly functions: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
}

function apiRouteBindings(body: readonly AstNode[]): ApiRouteBindings {
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || statement["importKind"] === "type") continue;
    const source = statement["source"];
    if (!isNode(source) || stringValue(source) !== API_ROUTE_MODULE) continue;
    for (const specifier of nodesAt(statement, "specifiers")) {
      if (specifier["importKind"] === "type") continue;
      const local = identifierName(specifier["local"]);
      if (local === undefined) continue;
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local);
      else if (
        specifier.type === "ImportSpecifier" &&
        moduleExportName(specifier["imported"]) === "apiRoute"
      ) {
        functions.add(local);
      }
    }
  }
  return { functions, namespaces };
}

function isApiRouteCall(node: AstNode, bindings: ApiRouteBindings): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node["callee"];
  if (!isNode(callee)) return false;
  const target = unwrapExpression(callee);
  const direct = identifierName(target);
  if (direct !== undefined) return bindings.functions.has(direct);
  if (target.type !== "MemberExpression" || target["computed"] === true) return false;
  const object = identifierName(target["object"]);
  return (
    object !== undefined &&
    bindings.namespaces.has(object) &&
    identifierName(target["property"]) === "apiRoute"
  );
}

/** The expression a module exports as `default`, following one hop through a top-level binding. */
function defaultExpression(body: readonly AstNode[]): AstNode | undefined {
  const initializers = new Map<string, AstNode>();
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement["declaration"] : statement;
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") continue;
    for (const declarator of nodesAt(declaration, "declarations")) {
      const name = identifierName(declarator["id"]);
      const init = declarator["init"];
      if (name !== undefined && isNode(init)) initializers.set(name, unwrapExpression(init));
    }
  }
  const resolve = (node: AstNode): AstNode | undefined => {
    const inner = unwrapExpression(node);
    const name = identifierName(inner);
    return name === undefined ? inner : initializers.get(name);
  };
  for (const statement of body) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement["declaration"];
      return isNode(declaration) ? resolve(declaration) : undefined;
    }
    if (statement.type === "ExportNamedDeclaration" && !isNode(statement["source"])) {
      for (const specifier of nodesAt(statement, "specifiers")) {
        if (moduleExportName(specifier["exported"]) !== "default") continue;
        const local = specifier["local"];
        if (isNode(local)) return resolve(local);
      }
    }
  }
  return undefined;
}

/** The methods named by the keys of the object literal given to `apiRoute`. */
function apiRouteMethods(call: AstNode): DefaultApiRoute {
  const argument = nodesAt(call, "arguments")[0];
  const literal = argument === undefined ? undefined : unwrapExpression(argument);
  if (literal === undefined || literal.type !== "ObjectExpression") {
    return { methods: [], readable: false };
  }
  const found = new Set<string>();
  for (const property of nodesAt(literal, "properties")) {
    if (property.type !== "Property" || property["computed"] === true) {
      return { methods: [], readable: false };
    }
    const key = property["key"];
    const name = isNode(key) ? moduleExportName(key) : undefined;
    if (name === undefined) return { methods: [], readable: false };
    found.add(name);
  }
  return { methods: HTTP_METHODS.filter((method) => found.has(method)), readable: true };
}

function defaultApiRoute(body: readonly AstNode[]): DefaultApiRoute | undefined {
  const bindings = apiRouteBindings(body);
  if (bindings.functions.size === 0 && bindings.namespaces.size === 0) return undefined;
  const expression = defaultExpression(body);
  if (expression === undefined || !isApiRouteCall(expression, bindings)) return undefined;
  return apiRouteMethods(expression);
}

function literalSsr(init: AstNode): boolean | "data-only" | undefined {
  const inner = unwrapExpression(init);
  if (inner.type === "Literal") {
    const value = inner["value"];
    if (typeof value === "boolean") return value;
  }
  const text = stringValue(init);
  return text === "data-only" ? "data-only" : undefined;
}

/** A boolean literal (`true`, `false`, `false as const`), or undefined for any other expression. */
function literalBoolean(init: AstNode): boolean | undefined {
  const inner = unwrapExpression(init);
  if (inner.type !== "Literal") return undefined;
  const value = inner["value"];
  return typeof value === "boolean" ? value : undefined;
}

/** `revalidate`: a positive number of seconds, or `false`. Anything else is not read. */
function literalRevalidate(init: AstNode): number | false | undefined {
  const inner = unwrapExpression(init);
  if (inner.type !== "Literal") return undefined;
  const value = inner["value"];
  if (value === false) return false;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** An array literal of string literals, or undefined. */
function literalStrings(init: AstNode): string[] | undefined {
  const inner = unwrapExpression(init);
  if (inner.type !== "ArrayExpression") return undefined;
  const elements = inner["elements"];
  if (!Array.isArray(elements)) return undefined;
  const out: string[] = [];
  for (const element of elements as unknown[]) {
    if (!isNode(element)) return undefined;
    const text = stringValue(element);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

/** `cache`: an object literal whose values are numbers or string arrays. Unknown keys are ignored. */
function literalCache(init: AstNode): RouteCacheOptions | undefined {
  const inner = unwrapExpression(init);
  if (inner.type !== "ObjectExpression") return undefined;
  const options: { staleSeconds?: number; cookies?: string[]; searchParams?: string[] } = {};
  for (const property of nodesAt(inner, "properties")) {
    if (property.type !== "Property" || property["computed"] === true) return undefined;
    const key = property["key"];
    const name = identifierName(key) ?? (isNode(key) ? stringValue(key) : undefined);
    const value = property["value"];
    if (!isNode(value)) return undefined;
    if (name === "staleSeconds") {
      const literal = unwrapExpression(value);
      const seconds = literal.type === "Literal" ? literal["value"] : undefined;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
      options.staleSeconds = seconds;
    } else if (name === "cookies") {
      const list = literalStrings(value);
      if (list === undefined) return undefined;
      options.cookies = list;
    } else if (name === "searchParams") {
      const list = literalStrings(value);
      if (list === undefined) return undefined;
      options.searchParams = list;
    }
  }
  return options;
}

function literalPrerender(init: AstNode): boolean | readonly string[] | undefined {
  const inner = unwrapExpression(init);
  if (inner.type === "Literal" && typeof inner["value"] === "boolean") return inner["value"];
  if (inner.type === "ArrayExpression") {
    const paths: string[] = [];
    const elements = inner["elements"];
    if (!Array.isArray(elements)) return undefined;
    for (const element of elements as unknown[]) {
      if (!isNode(element)) return undefined;
      const text = stringValue(element);
      if (text === undefined) return undefined;
      paths.push(text);
    }
    return paths;
  }
  return undefined;
}

/**
 * Reads the exports of a route module from its syntax tree. Nothing is executed. Handles
 * `export const|function|class`, `export { a as b }`, `export default`, re-exports and TypeScript
 * (type-only exports do not count).
 *
 * @param source Module text.
 * @param filename Used for the language and in errors.
 * @returns The export facts the scanner and the generator need.
 * @throws ModuleParseError for a syntax error.
 * @example
 * analyzeRouteModule("export default () => null; export const loader = () => 1;", "a.tsx").exports
 * // ["default", "loader"]
 * @since 1.0.0
 */
export function analyzeRouteModule(source: string, filename: string): RouteModuleInfo {
  const { body } = parseModule(source, filename);
  const names = new Set<string>();
  let hasStarExport = false;
  let ssr: boolean | "data-only" | undefined;
  let prerender: boolean | readonly string[] | undefined;
  let revalidate: number | false | undefined;
  let cache: RouteCacheOptions | undefined;
  let dynamicParams: boolean | undefined;

  const addDeclaration = (declaration: AstNode): void => {
    switch (declaration.type) {
      case "VariableDeclaration": {
        if (declaration["declare"] === true) break;
        for (const declarator of nodesAt(declaration, "declarations")) {
          const id = declarator["id"];
          if (!isNode(id)) continue;
          for (const name of patternNames(id)) names.add(name);
          const name = identifierName(id);
          const init = declarator["init"];
          if (name === undefined || !isNode(init)) continue;
          if (name === "ssr") ssr = literalSsr(init);
          else if (name === "prerender") prerender = literalPrerender(init);
          else if (name === "revalidate") revalidate = literalRevalidate(init);
          else if (name === "cache") cache = literalCache(init);
          else if (name === "dynamicParams") dynamicParams = literalBoolean(init);
        }
        break;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSEnumDeclaration":
      case "TSModuleDeclaration": {
        const name = identifierName(declaration["id"]);
        if (name !== undefined && declaration["declare"] !== true) names.add(name);
        break;
      }
      default:
        break;
    }
  };

  for (const statement of body) {
    if (statement.type === "ExportNamedDeclaration") {
      if (statement["exportKind"] === "type") continue;
      const declaration = statement["declaration"];
      if (isNode(declaration)) addDeclaration(declaration);
      for (const specifier of nodesAt(statement, "specifiers")) {
        if (specifier["exportKind"] === "type") continue;
        const name = moduleExportName(specifier["exported"]);
        if (name !== undefined) names.add(name);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement["declaration"];
      if (isNode(declaration) && declaration.type === "TSInterfaceDeclaration") continue;
      names.add("default");
    } else if (statement.type === "ExportAllDeclaration") {
      if (statement["exportKind"] === "type") continue;
      const exported = moduleExportName(statement["exported"]);
      if (exported === undefined) hasStarExport = true;
      else names.add(exported);
    }
  }

  const exports = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const methods = HTTP_METHODS.filter((method) => names.has(method));
  const config: {
    ssr?: boolean | "data-only";
    prerender?: boolean | readonly string[];
    revalidate?: number | false;
    cache?: RouteCacheOptions;
    dynamicParams?: boolean;
  } = {};
  if (ssr !== undefined) config.ssr = ssr;
  if (prerender !== undefined) config.prerender = prerender;
  if (revalidate !== undefined) config.revalidate = revalidate;
  if (cache !== undefined) config.cache = cache;
  if (dynamicParams !== undefined) config.dynamicParams = dynamicParams;
  return {
    hasDefault: names.has("default"),
    exports,
    methods,
    defaultApi: defaultApiRoute(body),
    hasStarExport,
    config,
  };
}

/**
 * What the build can read of one export of an image module. `absent`: the module does not export it. `literal`: the
 * export is a literal in the source, so its value is known. `computed`: the module exports it, but the value is not a
 * literal (a call, a variable, a re-export), so the build cannot know it and uses the default.
 * @since 1.0.0
 */
export type LiteralExport<T> =
  | { readonly state: "absent" }
  | { readonly state: "literal"; readonly value: T }
  | { readonly state: "computed" };

/**
 * The exports of an image module (`opengraph-image.tsx`, `twitter-image.tsx`) that the build reads: the alt text, the
 * size and the content type. Only literals are read; see {@link readImageExports}.
 * @since 1.0.0
 */
export interface ImageModuleExports {
  readonly alt: LiteralExport<string>;
  readonly size: LiteralExport<{ readonly width: number; readonly height: number }>;
  readonly contentType: LiteralExport<string>;
}

/** The names of the image module exports {@link readImageExports} reads. */
const IMAGE_EXPORT_NAMES: ReadonlySet<string> = new Set(["alt", "size", "contentType"]);

/** A whole or fractional number literal, or undefined for any other node. */
function numberLiteral(node: AstNode): number | undefined {
  const inner = unwrapExpression(node);
  if (inner.type !== "Literal") return undefined;
  const value = inner["value"];
  return typeof value === "number" ? value : undefined;
}

/**
 * The literal `{ width, height }` an object literal holds, or undefined when a side is missing or not a number literal,
 * or the object spreads or computes a key that could hold one.
 */
function literalSize(init: AstNode): { width: number; height: number } | undefined {
  const inner = unwrapExpression(init);
  if (inner.type !== "ObjectExpression") return undefined;
  let width: number | undefined;
  let height: number | undefined;
  for (const property of nodesAt(inner, "properties")) {
    if (property.type !== "Property" || property["computed"] === true) return undefined;
    const key = property["key"];
    const name = identifierName(key) ?? (isNode(key) ? stringValue(key) : undefined);
    const value = property["value"];
    if (!isNode(value)) return undefined;
    if (name === "width") width = numberLiteral(value);
    else if (name === "height") height = numberLiteral(value);
  }
  return width === undefined || height === undefined ? undefined : { width, height };
}

/**
 * Reads the `alt`, `size` and `contentType` exports of an image module from its syntax tree; nothing is executed. An
 * export counts as a literal only when it is declared in the module as `export const name = <literal>` (a string, a
 * template without substitutions, or `{ width, height }` of numbers, with `as const` and TypeScript annotations
 * allowed). A name exported any other way (a function, a variable from elsewhere, `export { x as alt }`) is `computed`.
 *
 * @param source Module text.
 * @param filename Used for the language and in errors.
 * @returns The three exports, each absent, literal or computed.
 * @throws ModuleParseError for a syntax error.
 * @example
 * readImageExports('export const alt = "Logo"; export const size = { width: 600, height: 315 };', "a.tsx").size;
 * // { state: "literal", value: { width: 600, height: 315 } }
 * @since 1.0.0
 */
export function readImageExports(source: string, filename: string): ImageModuleExports {
  const { body } = parseModule(source, filename);
  // The initializer of each literal-able export, or undefined when the export is declared some other way.
  const declared = new Map<string, AstNode | undefined>();
  for (const statement of body) {
    if (statement.type !== "ExportNamedDeclaration" || statement["exportKind"] === "type") continue;
    const declaration = statement["declaration"];
    if (isNode(declaration)) {
      if (declaration.type !== "VariableDeclaration") {
        for (const name of declaredNames(declaration)) {
          if (IMAGE_EXPORT_NAMES.has(name)) declared.set(name, undefined);
        }
        continue;
      }
      for (const declarator of nodesAt(declaration, "declarations")) {
        const name = identifierName(declarator["id"]);
        if (name === undefined || !IMAGE_EXPORT_NAMES.has(name)) continue;
        const init = declarator["init"];
        declared.set(name, isNode(init) ? init : undefined);
      }
      continue;
    }
    for (const specifier of nodesAt(statement, "specifiers")) {
      const name = moduleExportName(specifier["exported"]);
      if (name !== undefined && IMAGE_EXPORT_NAMES.has(name)) declared.set(name, undefined);
    }
  }
  const of = <T>(name: string, read: (init: AstNode) => T | undefined): LiteralExport<T> => {
    if (!declared.has(name)) return { state: "absent" };
    const init = declared.get(name);
    const value = init === undefined ? undefined : read(init);
    return value === undefined ? { state: "computed" } : { state: "literal", value };
  };
  return {
    alt: of("alt", (init) => stringValue(init)),
    size: of("size", literalSize),
    contentType: of("contentType", (init) => stringValue(init)),
  };
}

/** The names a non-variable declaration binds (a function, a class or an enum). */
function declaredNames(declaration: AstNode): string[] {
  const name = identifierName(declaration["id"]);
  return name === undefined ? [] : [name];
}

/**
 * True for an export name that is an HTTP method.
 *
 * @example isMethodExport("POST"); // true
 * @since 1.0.0
 */
export function isMethodExport(name: string): name is HttpMethod {
  return isHttpMethod(name);
}
