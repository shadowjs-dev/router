import { parseSync } from "oxc-parser";

/**
 * Parsing helpers shared by the route scanner, the route-splitting transform and the
 * server-function transform of Dusk. Everything works on the ESTree that `oxc-parser`
 * returns (TypeScript and JSX included); positions are UTF-16 offsets into the source.
 */

/** Structural view of an ESTree node. @since 1.0.0 */
export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

/**
 * True for an ESTree node. @since 1.0.0
 *
 * @example isNode(parsed.program); // true
 */
export function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

/**
 * Children of `node` stored under `key`, in source order for arrays.
 *
 * @example nodesAt(statement, "specifiers"); // the specifier nodes, or []
 * @since 1.0.0
 */
export function nodesAt(node: AstNode, key: string): readonly AstNode[] {
  const value = node[key];
  if (Array.isArray(value)) return value.filter(isNode);
  return isNode(value) ? [value] : [];
}

/** A parsed module. @since 1.0.0 */
export interface ParsedModule {
  readonly program: AstNode;
  readonly body: readonly AstNode[];
  readonly source: string;
  readonly filename: string;
}

/**
 * A syntax error with position and code frame.
 * @example
 * import { ModuleParseError, parseModule } from "@shadow-js/router/vite";
 * try {
 *   parseModule("export const = 1;", "bad.ts");
 * } catch (error) {
 *   error instanceof ModuleParseError; // true, with the file, line and column
 * }
 * @since 1.0.0
 */
export class ModuleParseError extends Error {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly frame: string;

  constructor(file: string, message: string, line: number, column: number, frame: string) {
    super(`${file}:${line}:${column}: ${message}\n${frame}`);
    this.name = "ModuleParseError";
    this.file = file;
    this.line = line;
    this.column = column;
    this.frame = frame;
  }
}

/**
 * 1-based line and 0-based column of an offset.
 *
 * @example lineColumn("a\nb", 2); // { line: 2, column: 0 }
 * @since 1.0.0
 */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, source.length);
  for (let index = 0; index < limit; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/**
 * Three lines of source around `offset`, with a caret under the column.
 *
 * @example codeFrame(source, offset); // three lines of source with a caret
 * @since 1.0.0
 */
export function codeFrame(source: string, offset: number): string {
  const { line, column } = lineColumn(source, offset);
  const lines = source.split("\n");
  const from = Math.max(1, line - 1);
  const to = Math.min(lines.length, line + 1);
  const out: string[] = [];
  for (let number = from; number <= to; number += 1) {
    const text = lines[number - 1] ?? "";
    out.push(`${String(number).padStart(4, " ")} | ${text}`);
    if (number === line) out.push(`     | ${" ".repeat(column)}^`);
  }
  return out.join("\n");
}

type Lang = "tsx" | "ts" | "jsx";

function languageOf(filename: string): Lang {
  const name = filename.split("?")[0]?.toLowerCase() ?? "";
  if (name.endsWith(".tsx")) return "tsx";
  if (name.endsWith(".ts") || name.endsWith(".mts") || name.endsWith(".cts")) return "ts";
  return "jsx";
}

/**
 * Parses a module (TypeScript and JSX allowed by file extension).
 *
 * @param source Module text.
 * @param filename Used for the language and in errors.
 * @returns The program.
 * @throws ModuleParseError with a code frame for a syntax error.
 * @example
 * const { body } = parseModule("export const a = 1;", "a.ts");
 * @since 1.0.0
 */
export function parseModule(source: string, filename: string): ParsedModule {
  const result = parseSync(filename, source, { lang: languageOf(filename), sourceType: "module" });
  const first = result.errors[0];
  if (first !== undefined) {
    const start = first.labels?.[0]?.start ?? 0;
    const { line, column } = lineColumn(source, start);
    throw new ModuleParseError(filename, first.message, line, column, codeFrame(source, start));
  }
  const program = result.program as unknown as AstNode;
  return { program, body: nodesAt(program, "body"), source, filename };
}

/**
 * The name an export or import specifier names (identifier or string literal).
 *
 * @example moduleExportName(specifier["exported"]); // "default"
 * @since 1.0.0
 */
export function moduleExportName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Identifier")
    return typeof node["name"] === "string" ? node["name"] : undefined;
  if (node.type === "Literal") return typeof node["value"] === "string" ? node["value"] : undefined;
  return undefined;
}

/**
 * Identifier name of a node, or undefined.
 *
 * @example identifierName(declarator["id"]); // "loader"
 * @since 1.0.0
 */
export function identifierName(node: unknown): string | undefined {
  if (isNode(node) && node.type === "Identifier" && typeof node["name"] === "string") {
    return node["name"];
  }
  return undefined;
}

/**
 * Strips parentheses and TypeScript expression wrappers (`as`, `satisfies`, `!`, `<T>x`).
 *
 * @example unwrapExpression(init); // the expression without `as`, `satisfies` and parentheses
 * @since 1.0.0
 */
export function unwrapExpression(node: AstNode): AstNode {
  let current = node;
  for (;;) {
    const inner = current["expression"];
    const wrapper =
      current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion";
    if (wrapper && isNode(inner)) {
      current = inner;
      continue;
    }
    return current;
  }
}

/**
 * The string value of a string literal (or a template literal without holes), else undefined.
 *
 * @example stringValue(property["value"]); // "GET"
 * @since 1.0.0
 */
export function stringValue(node: AstNode): string | undefined {
  const inner = unwrapExpression(node);
  if (inner.type === "Literal" && typeof inner["value"] === "string") return inner["value"];
  if (inner.type === "TemplateLiteral") {
    const expressions = nodesAt(inner, "expressions");
    const quasis = nodesAt(inner, "quasis");
    const only = quasis[0];
    if (expressions.length === 0 && quasis.length === 1 && only !== undefined) {
      const value = only["value"];
      if (typeof value === "object" && value !== null) {
        const cooked = (value as { cooked?: unknown }).cooked;
        if (typeof cooked === "string") return cooked;
      }
    }
  }
  return undefined;
}

/**
 * Names bound by a binding pattern (`a`, `{ a, b: [c] }`, `[a = 1, ...rest]`, a TypeScript
 * parameter property). Iterative: pattern depth is user controlled.
 *
 * @param pattern A pattern node (a declarator `id`, a function parameter, a catch parameter).
 * @returns The names in source order.
 * @since 1.0.0
 * @example patternNames(declarator["id"]); // ["a", "b"] for `{ a, b: [c] }` -> ["a", "c"]
 */
export function patternNames(pattern: AstNode): string[] {
  const names: string[] = [];
  const stack: AstNode[] = [pattern];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    switch (node.type) {
      case "Identifier": {
        const name = identifierName(node);
        if (name !== undefined) names.push(name);
        break;
      }
      case "ObjectPattern": {
        const properties = nodesAt(node, "properties");
        for (let index = properties.length - 1; index >= 0; index -= 1) {
          const property = properties[index];
          if (property === undefined) continue;
          if (property.type === "RestElement") stack.push(property);
          else {
            const value = property["value"];
            if (isNode(value)) stack.push(value);
          }
        }
        break;
      }
      case "ArrayPattern": {
        const elements = node["elements"];
        if (Array.isArray(elements)) {
          for (let index = elements.length - 1; index >= 0; index -= 1) {
            const element: unknown = elements[index];
            if (isNode(element)) stack.push(element);
          }
        }
        break;
      }
      case "AssignmentPattern": {
        const left = node["left"];
        if (isNode(left)) stack.push(left);
        break;
      }
      case "RestElement": {
        const argument = node["argument"];
        if (isNode(argument)) stack.push(argument);
        break;
      }
      case "TSParameterProperty": {
        const parameter = node["parameter"];
        if (isNode(parameter)) stack.push(parameter);
        break;
      }
      default:
        break;
    }
  }
  return names;
}

/** Keys that hold TypeScript types: not runtime code, not walked. */
const TYPE_KEYS: ReadonlySet<string> = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
]);

/**
 * Visits every node below `root` (including `root`), parents first, children in source order,
 * without recursion. TypeScript type annotations are skipped.
 *
 * @param root Where to start.
 * @param visit Called with the node, its parent and the key it hangs under. Return `false` to
 *   skip the node's children.
 * @example
 * walkTree(program, (node) => { if (node.type === "CallExpression") calls.push(node); });
 * @since 1.0.0
 */
export function walkTree(
  root: AstNode,
  visit: (
    node: AstNode,
    parent: AstNode | undefined,
    key: string | undefined,
  ) => boolean | undefined,
): void {
  const stack: { node: AstNode; parent: AstNode | undefined; key: string | undefined }[] = [
    { node: root, parent: undefined, key: undefined },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (visit(item.node, item.parent, item.key) === false) continue;
    const children: { node: AstNode; key: string }[] = [];
    for (const key of Object.keys(item.node)) {
      if (key === "type" || key === "start" || key === "end" || TYPE_KEYS.has(key)) continue;
      const value = item.node[key];
      if (Array.isArray(value)) {
        for (const entry of value as unknown[])
          if (isNode(entry)) children.push({ node: entry, key });
      } else if (isNode(value)) {
        children.push({ node: value, key });
      }
    }
    children.sort((a, b) => a.node.start - b.node.start);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ node: child.node, parent: item.node, key: child.key });
    }
  }
}
