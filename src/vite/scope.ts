import {
  type AstNode,
  identifierName,
  isNode,
  moduleExportName,
  nodesAt,
  patternNames,
} from "./ast";

/**
 * Scope analysis for module pruning. For a piece of syntax it finds the *free references*: names
 * read in value positions that no enclosing local scope binds. Those are the names a module-level
 * declaration can be needed by. TypeScript type positions are ignored (they are erased), JSX
 * component names count as references, and shadowing by parameters, blocks, catch clauses, class
 * and function names is honored.
 *
 * The traversal is iterative: the depth of user code is not bounded.
 */

type Mode = "expr" | "pattern";

type Task =
  | { readonly kind: "visit"; readonly node: AstNode; readonly mode: Mode }
  | { readonly kind: "pop" };

/** Keys that hold TypeScript types or other erased syntax on any node. */
const ERASED_KEYS: ReadonlySet<string> = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
  "type",
  "start",
  "end",
  "range",
  "loc",
  "parent",
]);

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** TypeScript expression wrappers whose `expression` child is runtime code. */
const TS_WRAPPERS: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSExportAssignment",
]);

function isUppercaseStart(name: string): boolean {
  const code = name.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a;
}

/** Names declared directly in a statement list (`let`, `const`, class, function, enum). */
function lexicalNames(statements: readonly AstNode[]): string[] {
  const names: string[] = [];
  for (const wrapper of statements) {
    // `export const a = 1` inside a namespace body declares `a` in that scope.
    const inner = wrapper.type === "ExportNamedDeclaration" ? wrapper["declaration"] : undefined;
    const statement = isNode(inner) ? inner : wrapper;
    switch (statement.type) {
      case "VariableDeclaration":
        if (statement["kind"] !== "var" && statement["declare"] !== true) {
          for (const declarator of nodesAt(statement, "declarations")) {
            const id = declarator["id"];
            if (isNode(id)) names.push(...patternNames(id));
          }
        }
        break;
      case "ClassDeclaration":
      case "FunctionDeclaration":
      case "TSEnumDeclaration": {
        const name = identifierName(statement["id"]);
        if (name !== undefined && statement["declare"] !== true) names.push(name);
        break;
      }
      default:
        break;
    }
  }
  return names;
}

/** `var` names declared anywhere in a function body (not inside nested functions or classes). */
function varNames(body: AstNode): string[] {
  const names: string[] = [];
  const stack: AstNode[] = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (
      FUNCTION_TYPES.has(node.type) ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression"
    ) {
      continue;
    }
    if (node.type === "VariableDeclaration" && node["kind"] === "var") {
      for (const declarator of nodesAt(node, "declarations")) {
        const id = declarator["id"];
        if (isNode(id)) names.push(...patternNames(id));
      }
      continue;
    }
    switch (node.type) {
      case "BlockStatement":
      case "StaticBlock":
        stack.push(...nodesAt(node, "body"));
        break;
      case "IfStatement":
        stack.push(...nodesAt(node, "consequent"), ...nodesAt(node, "alternate"));
        break;
      case "ForStatement":
        stack.push(...nodesAt(node, "init"), ...nodesAt(node, "body"));
        break;
      case "ForInStatement":
      case "ForOfStatement":
        stack.push(...nodesAt(node, "left"), ...nodesAt(node, "body"));
        break;
      case "WhileStatement":
      case "DoWhileStatement":
      case "LabeledStatement":
      case "WithStatement":
        stack.push(...nodesAt(node, "body"));
        break;
      case "TryStatement":
        stack.push(
          ...nodesAt(node, "block"),
          ...nodesAt(node, "handler"),
          ...nodesAt(node, "finalizer"),
        );
        break;
      case "CatchClause":
        stack.push(...nodesAt(node, "body"));
        break;
      case "SwitchStatement":
        for (const switchCase of nodesAt(node, "cases"))
          stack.push(...nodesAt(switchCase, "consequent"));
        break;
      default:
        break;
    }
  }
  return names;
}

/**
 * Free references of a piece of syntax: value-position names that no scope inside it binds.
 *
 * @param root A statement, declarator, function or expression node.
 * @param initialMode `"pattern"` treats `root` as a binding pattern (defaults and computed keys
 *   are references, bound names are not).
 * @param onVisit Called for every node before it is processed, with a function telling whether a
 *   name is bound by a scope open at that node. Return true to skip the node's subtree.
 * @returns The names, unordered.
 * @example
 * freeReferences(parsed.body[0]); // new Set(["fetch", "db"]) for `const x = db.get(fetch)`
 * @since 1.0.0
 */
export function freeReferences(
  root: AstNode,
  initialMode: Mode = "expr",
  onVisit?: (node: AstNode, isLocal: (name: string) => boolean) => boolean,
): Set<string> {
  const refs = new Set<string>();
  const scopes: Set<string>[] = [];
  const isLocal = (name: string): boolean => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (scopes[index]?.has(name) === true) return true;
    }
    return false;
  };
  const reference = (name: string): void => {
    if (!isLocal(name)) refs.add(name);
  };

  const stack: Task[] = [{ kind: "visit", node: root, mode: initialMode }];
  const push = (node: unknown, mode: Mode = "expr"): void => {
    if (isNode(node)) stack.push({ kind: "visit", node, mode });
  };
  const pushAll = (nodes: readonly AstNode[], mode: Mode = "expr"): void => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node !== undefined) stack.push({ kind: "visit", node, mode });
    }
  };
  /** Opens a scope with `names`; the matching pop runs after everything pushed afterward. */
  const openScope = (names: Iterable<string>): void => {
    scopes.push(new Set(names));
    stack.push({ kind: "pop" });
  };

  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) break;
    if (task.kind === "pop") {
      scopes.pop();
      continue;
    }
    const { node, mode } = task;
    const type = node.type;
    if (onVisit?.(node, isLocal) === true) continue;

    if (type === "Identifier") {
      if (mode === "expr") {
        const name = identifierName(node);
        if (name !== undefined) reference(name);
      }
      continue;
    }

    if (mode === "pattern") {
      switch (type) {
        case "ObjectPattern":
          for (const property of nodesAt(node, "properties")) {
            if (property.type === "RestElement") {
              push(property["argument"], "pattern");
            } else {
              if (property["computed"] === true) push(property["key"]);
              push(property["value"], "pattern");
            }
          }
          continue;
        case "ArrayPattern": {
          const elements = node["elements"];
          if (Array.isArray(elements)) {
            for (const element of elements as unknown[]) push(element, "pattern");
          }
          continue;
        }
        case "AssignmentPattern":
          push(node["left"], "pattern");
          push(node["right"]);
          continue;
        case "RestElement":
          push(node["argument"], "pattern");
          continue;
        case "TSParameterProperty":
          push(node["parameter"], "pattern");
          continue;
        default:
          break;
      }
    }

    if (FUNCTION_TYPES.has(type)) {
      const params = nodesAt(node, "params");
      const names: string[] = [];
      for (const param of params) names.push(...patternNames(param));
      const id = identifierName(node["id"]);
      if (type === "FunctionExpression" && id !== undefined) names.push(id);
      const body = node["body"];
      if (isNode(body) && body.type === "BlockStatement") names.push(...varNames(body));
      names.push("arguments");
      openScope(names);
      push(body);
      pushAll(params, "pattern");
      continue;
    }

    switch (type) {
      case "BlockStatement":
      case "StaticBlock": {
        const body = nodesAt(node, "body");
        const names = lexicalNames(body);
        if (type === "StaticBlock") names.push(...varNames(node));
        openScope(names);
        pushAll(body);
        continue;
      }
      case "ForStatement": {
        const init = node["init"];
        const names =
          isNode(init) && init.type === "VariableDeclaration" ? lexicalNames([init]) : [];
        openScope(names);
        push(node["body"]);
        push(node["update"]);
        push(node["test"]);
        push(init);
        continue;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const left = node["left"];
        const names =
          isNode(left) && left.type === "VariableDeclaration" ? lexicalNames([left]) : [];
        openScope(names);
        push(node["body"]);
        push(node["right"]);
        push(left);
        continue;
      }
      case "CatchClause": {
        const param = node["param"];
        openScope(isNode(param) ? patternNames(param) : []);
        push(node["body"]);
        push(param, "pattern");
        continue;
      }
      case "SwitchStatement": {
        const cases = nodesAt(node, "cases");
        const statements: AstNode[] = [];
        for (const switchCase of cases) statements.push(...nodesAt(switchCase, "consequent"));
        push(node["discriminant"]);
        openScope(lexicalNames(statements));
        pushAll(cases);
        continue;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        const id = identifierName(node["id"]);
        openScope(id === undefined ? [] : [id]);
        push(node["body"]);
        push(node["superClass"]);
        pushAll(nodesAt(node, "decorators"));
        continue;
      }
      case "MethodDefinition":
      case "PropertyDefinition":
      case "AccessorProperty":
        pushAll(nodesAt(node, "decorators"));
        if (node["computed"] === true) push(node["key"]);
        push(node["value"]);
        continue;
      case "Property":
        if (node["computed"] === true) push(node["key"]);
        push(node["value"]);
        continue;
      case "MemberExpression":
        push(node["object"]);
        if (node["computed"] === true) push(node["property"]);
        continue;
      case "VariableDeclaration":
        if (node["declare"] === true) continue;
        pushAll(nodesAt(node, "declarations"));
        continue;
      case "VariableDeclarator":
        push(node["init"]);
        push(node["id"], "pattern");
        continue;
      case "LabeledStatement":
        push(node["body"]);
        continue;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
      case "JSXClosingElement":
      case "JSXIdentifier":
      case "JSXNamespacedName":
      case "ImportDeclaration":
        continue;
      case "TSEnumDeclaration": {
        const enumBody = node["body"];
        const members = isNode(enumBody) ? nodesAt(enumBody, "members") : [];
        const memberNames: string[] = [];
        for (const member of members) {
          const name = moduleExportName(member["id"]);
          if (name !== undefined) memberNames.push(name);
        }
        openScope(memberNames);
        for (const member of members) push(member["initializer"]);
        continue;
      }
      case "TSModuleDeclaration": {
        if (node["declare"] === true) continue;
        const body = node["body"];
        if (isNode(body) && body.type === "TSModuleBlock") {
          const statements = nodesAt(body, "body");
          openScope(lexicalNames(statements));
          pushAll(statements);
        }
        continue;
      }
      case "TSImportEqualsDeclaration": {
        let reference_: unknown = node["moduleReference"];
        while (isNode(reference_) && reference_.type === "TSQualifiedName") {
          reference_ = reference_["left"];
        }
        const name = identifierName(reference_);
        if (name !== undefined) reference(name);
        continue;
      }
      case "JSXOpeningElement": {
        const name = node["name"];
        if (isNode(name)) {
          if (name.type === "JSXIdentifier") {
            const text = typeof name["name"] === "string" ? name["name"] : "";
            if (text !== "" && isUppercaseStart(text)) reference(text);
          } else if (name.type === "JSXMemberExpression") {
            let object: unknown = name;
            while (isNode(object) && object.type === "JSXMemberExpression")
              object = object["object"];
            if (
              isNode(object) &&
              object.type === "JSXIdentifier" &&
              typeof object["name"] === "string"
            ) {
              reference(object["name"]);
            }
          }
        }
        pushAll(nodesAt(node, "attributes"));
        continue;
      }
      case "JSXAttribute":
        push(node["value"]);
        continue;
      case "TSDeclareFunction":
      case "TSEmptyBodyFunctionExpression":
      case "TSAbstractMethodDefinition":
      case "TSAbstractPropertyDefinition":
        continue;
      default:
        break;
    }

    if (TS_WRAPPERS.has(type)) {
      push(node["expression"]);
      continue;
    }
    if (type.startsWith("TS")) continue;

    // Generic node: visit every child that is not erased syntax, in source order.
    const children: AstNode[] = [];
    for (const key of Object.keys(node)) {
      if (ERASED_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value as unknown[]) if (isNode(item)) children.push(item);
      } else if (isNode(value)) {
        children.push(value);
      }
    }
    children.sort((a, b) => a.start - b.start);
    pushAll(children);
  }
  return refs;
}

/**
 * Names that a function (or any node) inside a statement reads from the enclosing *local* scopes:
 * parameters, block variables, loop variables, catch parameters and names of enclosing functions
 * and classes. Module-level names and globals are not captures. A function that captures cannot be
 * moved to another place (or another machine) without taking those values with it.
 *
 * @param statement The top-level statement that contains `target`.
 * @param target The function node to check.
 * @returns The captured names, sorted; empty when the function is self-contained.
 * @example
 * findCaptures(parsed.body[0], fnNode); // ["userId"] for `(userId) => async () => { fetch(userId) }`
 * @since 1.0.0
 */
export function findCaptures(statement: AstNode, target: AstNode): string[] {
  const captured = new Set<string>();
  freeReferences(statement, "expr", (node, isLocal) => {
    if (node !== target) return false;
    // A declaration's own name is bound by the enclosing scope but is not a capture of itself.
    const own = target.type === "FunctionDeclaration" ? identifierName(target["id"]) : undefined;
    for (const name of freeReferences(target)) {
      if (name !== own && isLocal(name)) captured.add(name);
    }
    return true;
  });
  return [...captured].sort();
}
