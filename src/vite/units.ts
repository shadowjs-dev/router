import {
  type AstNode,
  identifierName,
  isNode,
  moduleExportName,
  nodesAt,
  type ParsedModule,
  patternNames,
} from "./ast";
import { freeReferences } from "./scope";

/**
 * Splits a module into *units*: the smallest pieces that can be kept or dropped on their own. An
 * import specifier, a variable declarator, a function or class declaration, an export specifier or
 * a side-effect statement is a unit. Each unit knows what it declares, what it reads and what it
 * exports, so reachability can be computed without running anything.
 */

/** What a unit is. @since 1.0.0 */
export type UnitKind =
  /** One import specifier (`a`, `b as c`, `* as ns`, the default import). */
  | "import-specifier"
  /** One variable declarator, exported or not. */
  | "declarator"
  /** A function, class or enum declaration (also `export default function`). */
  | "declaration"
  /** `export default <expression>`. */
  | "export-default"
  /** `export { a as b }` of a local name, or `export { a } from "x"`. */
  | "export-specifier"
  /** `export * from "x"`. */
  | "export-all"
  /** A statement with effects: `import "x"`, calls, `if`, loops, directives... */
  | "effect"
  /** Syntax that TypeScript erases (interfaces, aliases, `import type`). Always kept. */
  | "type";

/** One keep-or-drop piece of a module. @since 1.0.0 */
export interface Unit {
  readonly index: number;
  readonly kind: UnitKind;
  /** The top-level statement the unit belongs to. */
  readonly statement: AstNode;
  /** The node that is removed when the unit is dropped (declarator, specifier or statement). */
  readonly node: AstNode;
  /** Module-level names the unit declares. */
  readonly declares: readonly string[];
  /** Free names the unit reads. */
  readonly refs: ReadonlySet<string>;
  /** Names the unit exports (`default` for the default export). */
  readonly exports: readonly string[];
}

/** The units of a module, grouped by statement. @since 1.0.0 */
export interface ModuleUnits {
  readonly units: readonly Unit[];
  /** Units of each top-level statement, in order. */
  readonly statements: readonly {
    readonly statement: AstNode;
    readonly units: readonly Unit[];
  }[];
  /** Units declaring a name. */
  readonly declaredBy: ReadonlyMap<string, readonly Unit[]>;
}

const NO_REFS: ReadonlySet<string> = new Set<string>();

function isTypeDeclaration(node: AstNode): boolean {
  return (
    node.type === "TSInterfaceDeclaration" ||
    node.type === "TSTypeAliasDeclaration" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSExportAssignment" ||
    (node.type === "TSModuleDeclaration" && node["declare"] === true) ||
    (node.type === "TSEnumDeclaration" && node["declare"] === true) ||
    ((node.type === "ClassDeclaration" || node.type === "FunctionDeclaration") &&
      node["declare"] === true) ||
    (node.type === "VariableDeclaration" && node["declare"] === true)
  );
}

/**
 * Computes the units of a parsed module.
 *
 * @param module A module from `parseModule`.
 * @param skip Nodes whose subtrees do not count as references (code that is about to be replaced).
 * @returns The units, in source order.
 * @example
 * const { units } = collectUnits(parseModule("import a from 'a'; export const b = a;", "x.ts"));
 * units.map((unit) => unit.kind); // ["import-specifier", "declarator"]
 * @since 1.0.0
 */
export function collectUnits(module: ParsedModule, skip?: ReadonlySet<AstNode>): ModuleUnits {
  const refsOf = (node: AstNode): Set<string> =>
    skip === undefined || skip.size === 0
      ? freeReferences(node)
      : freeReferences(node, "expr", (visited) => skip.has(visited));
  const units: Unit[] = [];
  const statements: { statement: AstNode; units: Unit[] }[] = [];

  for (const statement of module.body) {
    const own: Unit[] = [];
    const add = (
      kind: UnitKind,
      node: AstNode,
      declares: readonly string[],
      refs: ReadonlySet<string>,
      exports: readonly string[],
    ): void => {
      const unit: Unit = { index: units.length, kind, statement, node, declares, refs, exports };
      units.push(unit);
      own.push(unit);
    };
    const typeUnit = (): void => add("type", statement, [], NO_REFS, []);

    const declarationUnits = (declaration: AstNode, exported: boolean): void => {
      if (isTypeDeclaration(declaration)) {
        typeUnit();
        return;
      }
      if (declaration.type === "VariableDeclaration") {
        for (const declarator of nodesAt(declaration, "declarations")) {
          const id = declarator["id"];
          const names = isNode(id) ? patternNames(id) : [];
          add("declarator", declarator, names, refsOf(declarator), exported ? names : []);
        }
        return;
      }
      const name = identifierName(declaration["id"]);
      add(
        "declaration",
        statement,
        name === undefined ? [] : [name],
        refsOf(declaration),
        exported ? (name === undefined ? ["default"] : [name]) : [],
      );
    };

    switch (statement.type) {
      case "ImportDeclaration": {
        const specifiers = nodesAt(statement, "specifiers");
        if (statement["importKind"] === "type") {
          typeUnit();
        } else if (specifiers.length === 0) {
          add("effect", statement, [], NO_REFS, []);
        } else {
          for (const specifier of specifiers) {
            const local = identifierName(specifier["local"]);
            if (local === undefined) continue;
            if (specifier["importKind"] === "type") {
              add("type", specifier, [], NO_REFS, []);
            } else {
              add("import-specifier", specifier, [local], NO_REFS, []);
            }
          }
        }
        break;
      }
      case "ExportNamedDeclaration": {
        if (statement["exportKind"] === "type") {
          typeUnit();
          break;
        }
        const declaration = statement["declaration"];
        if (isNode(declaration)) {
          declarationUnits(declaration, true);
          break;
        }
        const reexport = isNode(statement["source"]);
        for (const specifier of nodesAt(statement, "specifiers")) {
          if (specifier["exportKind"] === "type") {
            add("type", specifier, [], NO_REFS, []);
            continue;
          }
          const exported = moduleExportName(specifier["exported"]);
          const local = moduleExportName(specifier["local"]);
          if (exported === undefined) continue;
          const refs = reexport || local === undefined ? NO_REFS : new Set<string>([local]);
          add("export-specifier", specifier, [], refs, [exported]);
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = statement["declaration"];
        if (!isNode(declaration)) break;
        if (declaration.type === "TSInterfaceDeclaration") {
          typeUnit();
        } else if (
          declaration.type === "FunctionDeclaration" ||
          declaration.type === "ClassDeclaration"
        ) {
          const name = identifierName(declaration["id"]);
          add("declaration", statement, name === undefined ? [] : [name], refsOf(declaration), [
            "default",
          ]);
        } else {
          add("export-default", statement, [], refsOf(declaration), ["default"]);
        }
        break;
      }
      case "ExportAllDeclaration": {
        if (statement["exportKind"] === "type") typeUnit();
        else
          add("export-all", statement, [], NO_REFS, [
            moduleExportName(statement["exported"]) ?? "*",
          ]);
        break;
      }
      case "VariableDeclaration":
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSEnumDeclaration":
        declarationUnits(statement, false);
        break;
      default:
        if (isTypeDeclaration(statement)) typeUnit();
        else add("effect", statement, [], refsOf(statement), []);
        break;
    }
    statements.push({ statement, units: own });
  }

  const declaredBy = new Map<string, Unit[]>();
  for (const unit of units) {
    for (const name of unit.declares) {
      const list = declaredBy.get(name) ?? [];
      list.push(unit);
      declaredBy.set(name, list);
    }
  }
  return { units, statements, declaredBy };
}

/**
 * Units reachable from `roots`: the roots, the units declaring any name they read, and so on.
 * Iterative, and each unit is visited once.
 *
 * @param module The module's units.
 * @param roots Starting units.
 * @returns The set of unit indices that are needed.
 * @since 1.0.0
 * @example const needed = reachableUnits(units, units.units.filter((unit) => unit.exports.includes("loader")));
 */
export function reachableUnits(module: ModuleUnits, roots: Iterable<Unit>): Set<number> {
  const alive = new Set<number>();
  const stack: Unit[] = [];
  for (const root of roots) {
    if (!alive.has(root.index)) {
      alive.add(root.index);
      stack.push(root);
    }
  }
  while (stack.length > 0) {
    const unit = stack.pop();
    if (unit === undefined) break;
    for (const name of unit.refs) {
      for (const declarer of module.declaredBy.get(name) ?? []) {
        if (!alive.has(declarer.index)) {
          alive.add(declarer.index);
          stack.push(declarer);
        }
      }
    }
  }
  return alive;
}
