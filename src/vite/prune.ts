import MagicString from "magic-string";
import { type AstNode, identifierName, isNode, type ParsedModule } from "./ast";
import { collectUnits, type ModuleUnits, reachableUnits, type Unit } from "./units";

/**
 * Removes the parts of a module that nothing keeps alive. The module is split into units
 * (see {@link collectUnits}); the units that must stay are the *roots* (exports that are kept,
 * side-effect statements, erased type syntax) and everything the roots read. All other units are cut
 * out with exact source ranges, so the rest of the file keeps its text, positions and source map.
 */

/** Options of {@link pruneModule}. @since 1.0.0 */
export interface PruneOptions {
  /**
   * Export names that stay. Exports not listed are removed. Omit to keep every export (only
   * unused module-level code and imports are removed).
   */
  readonly keepExports?: ReadonlySet<string>;
  /** Keep side-effect statements (`import "x"`, calls, loops, directives). Default true. */
  readonly keepEffects?: boolean;
  /**
   * Restrict what may be removed to units that declare only these names. Used to drop exactly the
   * code that became unused after an edit, never anything that was unused before.
   */
  readonly removable?: ReadonlySet<string>;
  /** Replaces the default choice of roots: units for which this returns true stay, with their needs. */
  readonly isRoot?: (unit: Unit) => boolean;
  /**
   * Nodes about to be replaced: what they read does not keep anything alive. Pair it with
   * `replacements` to swap code for something that reads less (a call for a stub). Only code that
   * the replaced nodes kept alive is removed; code that was unused before stays.
   */
  readonly skip?: ReadonlySet<AstNode>;
  /** Ranges to overwrite. A replacement inside a unit that is removed is dropped with it. */
  readonly replacements?: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }[];
  /** Text added before the first character (the source map accounts for it). */
  readonly prepend?: string;
  /** Text added after the last character. */
  readonly append?: string;
}

/** Outcome of {@link pruneModule}. @since 1.0.0 */
export interface PruneResult {
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]> | null;
  readonly changed: boolean;
  /** Module-level names that were removed. */
  readonly removed: readonly string[];
  /** Sources of `import "x"` statements that stayed (they run for their effects). */
  readonly sideEffectImports: readonly string[];
}

interface Range {
  start: number;
  end: number;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** Ranges that remove the dead items of a comma-separated list, commas included. */
function listRemovals(items: readonly AstNode[], dead: readonly boolean[]): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (dead[index] !== true) continue;
    const item = items[index];
    const next = items[index + 1];
    if (item === undefined) continue;
    if (next !== undefined) {
      ranges.push({ start: item.start, end: next.start });
      continue;
    }
    let previous = index - 1;
    while (previous >= 0 && dead[previous] === true) previous -= 1;
    const before = items[previous];
    ranges.push({ start: before === undefined ? item.start : before.end, end: item.end });
  }
  return ranges;
}

function importText(source: string, statement: AstNode, alive: ReadonlySet<AstNode>): string {
  const specifiers = (statement["specifiers"] as readonly AstNode[]).filter((node) =>
    alive.has(node),
  );
  const kind = statement["importKind"] === "type" ? "type " : "";
  let defaultName: string | undefined;
  let namespaceName: string | undefined;
  const named: string[] = [];
  for (const specifier of specifiers) {
    const local = identifierName(specifier["local"]) ?? "";
    if (specifier.type === "ImportDefaultSpecifier") defaultName = local;
    else if (specifier.type === "ImportNamespaceSpecifier") namespaceName = local;
    else {
      // Keep the specifier text exactly as written (`a`, `a as b`, `"x-y" as z`).
      named.push(source.slice(specifier.start, specifier.end));
    }
  }
  const parts: string[] = [];
  if (defaultName !== undefined) parts.push(defaultName);
  if (namespaceName !== undefined) parts.push(`* as ${namespaceName}`);
  if (named.length > 0) parts.push(`{ ${named.join(", ")} }`);
  const sourceNode = statement["source"] as AstNode;
  return `import ${kind}${parts.join(", ")} from ${source.slice(sourceNode.start, statement.end)}`;
}

/**
 * Cuts out everything a module does not need.
 *
 * @param module A parsed module (`parseModule`).
 * @param options Which exports and effects stay.
 * @returns The new text, a source map, and what was removed.
 * @example
 * const result = pruneModule(parseModule(code, "route.tsx"), { keepExports: new Set(["loader"]) });
 * @since 1.0.0
 */
export function pruneModule(module: ParsedModule, options: PruneOptions = {}): PruneResult {
  const units = collectUnits(module, options.skip);
  const keepEffects = options.keepEffects !== false;
  const keep = options.keepExports;
  const removable = options.removable;

  const isRoot = (unit: Unit): boolean => {
    if (options.isRoot !== undefined) return options.isRoot(unit);
    if (unit.kind === "type") return true;
    if (unit.kind === "effect") return keepEffects;
    if (unit.exports.length > 0) {
      if (keep === undefined) return true;
      return unit.exports.some((name) => keep.has(name) || (name === "*" && keep.has("*")));
    }
    if (removable === undefined) return false;
    return !(unit.declares.length > 0 && unit.declares.every((name) => removable.has(name)));
  };

  let roots = units.units.filter(isRoot);
  if (options.skip !== undefined && options.skip.size > 0) {
    // Code that was already unused before the replacement is none of our business: only units that
    // the replaced code kept alive may go. Units unreachable before the edit stay, with their needs.
    const before = collectUnits(module);
    const aliveBefore = reachableUnits(before, before.units.filter(isRoot));
    roots = [...roots, ...units.units.filter((unit) => !aliveBefore.has(unit.index))];
  }
  const alive = reachableUnits(units, roots);
  const dead = units.units.filter((unit) => !alive.has(unit.index));
  const replacements = options.replacements ?? [];
  if (
    dead.length === 0 &&
    replacements.length === 0 &&
    options.prepend === undefined &&
    options.append === undefined
  ) {
    return {
      code: module.source,
      map: null,
      changed: false,
      removed: [],
      sideEffectImports: sideEffectImports(units),
    };
  }

  const magic = new MagicString(module.source);
  const removed = new Set<string>();
  const ranges: Range[] = [];
  const wholeStatement = (statement: AstNode): void => {
    // Take the blanks after the statement, and the line break when the statement ends its line,
    // so removing a statement does not leave an empty line or a double space behind.
    let end = statement.end;
    while (module.source.charCodeAt(end) === 32 || module.source.charCodeAt(end) === 9) end += 1;
    if (module.source.charCodeAt(end) === 10) end += 1;
    else if (module.source.charCodeAt(end) === 13 && module.source.charCodeAt(end + 1) === 10)
      end += 2;
    let start = statement.start;
    if (end >= module.source.length) {
      while (
        start > 0 &&
        (module.source.charCodeAt(start - 1) === 32 || module.source.charCodeAt(start - 1) === 9)
      ) {
        start -= 1;
      }
    }
    ranges.push({ start, end });
  };

  for (const { statement, units: own } of units.statements) {
    if (own.length === 0 || !own.some((unit) => !alive.has(unit.index))) continue;
    for (const unit of own) {
      if (!alive.has(unit.index)) for (const name of unit.declares) removed.add(name);
    }
    if (own.every((unit) => !alive.has(unit.index))) {
      wholeStatement(statement);
      continue;
    }
    const deadFlags = own.map((unit) => !alive.has(unit.index));
    if (statement.type === "ImportDeclaration") {
      // Rebuild: type-only specifiers go with the statement when no value specifier is left.
      const aliveNodes = new Set<AstNode>();
      own.forEach((unit, index) => {
        if (deadFlags[index] !== true && unit.kind === "import-specifier")
          aliveNodes.add(unit.node);
      });
      if (aliveNodes.size === 0) {
        wholeStatement(statement);
        continue;
      }
      magic.overwrite(
        statement.start,
        statement.end,
        importText(module.source, statement, aliveNodes),
      );
      continue;
    }
    if (statement.type === "ExportNamedDeclaration" && !isNode(statement["declaration"])) {
      ranges.push(
        ...listRemovals(
          own.map((unit) => unit.node),
          deadFlags,
        ),
      );
      continue;
    }
    // One or more declarators of a variable declaration (exported or not).
    ranges.push(
      ...listRemovals(
        own.map((unit) => unit.node),
        deadFlags,
      ),
    );
  }

  const merged = mergeRanges(ranges);
  for (const replacement of replacements) {
    const removed = merged.some(
      (range) => replacement.start >= range.start && replacement.end <= range.end,
    );
    if (!removed) magic.overwrite(replacement.start, replacement.end, replacement.text);
  }
  for (const range of merged) {
    if (range.end > range.start) magic.remove(range.start, range.end);
  }
  if (options.prepend !== undefined) magic.prepend(options.prepend);
  if (options.append !== undefined) magic.append(options.append);
  return {
    code: magic.toString(),
    map: magic.generateMap({ source: module.filename, hires: "boundary", includeContent: true }),
    changed: true,
    removed: [...removed].sort(),
    sideEffectImports: sideEffectImports(units, new Set(dead.map((unit) => unit.index))),
  };
}

function sideEffectImports(units: ModuleUnits, dead: ReadonlySet<number> = new Set()): string[] {
  const sources: string[] = [];
  for (const unit of units.units) {
    if (unit.kind !== "effect" || unit.statement.type !== "ImportDeclaration") continue;
    if (dead.has(unit.index)) continue;
    const source = unit.statement["source"];
    if (isNode(source) && typeof source["value"] === "string") sources.push(source["value"]);
  }
  return sources;
}
