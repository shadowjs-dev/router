import { parseModule } from "./ast";
import { type PruneResult, pruneModule } from "./prune";
import { collectUnits, type Unit } from "./units";

/**
 * Export names of a route module that only the server may run.
 * @example
 * import { SERVER_ONLY_ROUTE_EXPORTS } from "@shadow-js/router/vite";
 * SERVER_ONLY_ROUTE_EXPORTS.includes("middleware"); // true
 * @since 1.0.0
 */
export const SERVER_ONLY_ROUTE_EXPORTS: readonly string[] = ["middleware"];

/**
 * Removes server-only exports from a route module's client copy. A route's `middleware` runs on the
 * server only, so the browser build drops the export and every import and declaration that only it
 * needed. Everything the remaining exports read stays, and so do side effects and directives.
 *
 * The client copy of a route module is what the browser imports, so a server-only export must never
 * reach it: an import of server code in middleware would otherwise fail the client build (or leak
 * the code into the bundle).
 *
 * @param source Module text.
 * @param filename Path used for the language and the source map.
 * @param names Export names to remove (`["middleware"]` for route modules).
 * @returns The pruned module, or `undefined` when none of the names is exported (nothing to do).
 * @example
 * const stripped = stripServerOnlyExports(code, "/app/src/routes/admin.tsx", ["middleware"]);
 * @since 1.0.0
 */
export function stripServerOnlyExports(
  source: string,
  filename: string,
  names: readonly string[],
): PruneResult | undefined {
  const module = parseModule(source, filename);
  const units = collectUnits(module);
  const dropped = (unit: Unit): boolean => unit.exports.some((name) => names.includes(name));
  if (!units.units.some(dropped)) return undefined;
  return pruneModule(module, {
    // Roots: what the kept exports need, plus everything that runs or describes the module itself.
    isRoot: (unit) =>
      unit.kind === "type" ||
      unit.kind === "effect" ||
      unit.statement["directive"] !== undefined ||
      (unit.exports.length > 0 && !dropped(unit)),
  });
}
