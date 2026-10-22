import { parseModule } from "./ast";
import { type PruneResult, pruneModule } from "./prune";
import { collectUnits, reachableUnits, type Unit } from "./units";

/**
 * Route code-splitting. A route module has two halves: the **data half** (everything that is not
 * UI: `loader`, `beforeLoad`, `validateSearch`, `head`, ...) which must be available as soon as
 * the router matches, and the **UI half** (`default`, `pending`, `error`, `notFound`) which is
 * loaded lazily. The route file itself becomes the data half, whose UI exports are lazy
 * components; the UI half is served under a query on the same file.
 */

/**
 * Query that selects the UI half of a route file.
 * @example
 * import { ROUTE_UI_QUERY } from "@shadow-js/router/vite";
 * ROUTE_UI_QUERY; // "shadow-route=ui"
 * @since 1.0.0
 */
export const ROUTE_UI_QUERY = "shadow-route=ui";

/** Why a route module was not split. @since 1.0.0 */
export type NoSplitReason =
  | "no-ui"
  | "star-export"
  | "side-effects"
  | "mixed-export"
  | "shared-declaration";

/** The outcome of {@link splitRouteModule}. @since 1.0.0 */
export type RouteSplit =
  | { readonly split: false; readonly reason: NoSplitReason; readonly detail: readonly string[] }
  | {
      readonly split: true;
      /** The UI exports found, in the order default, pending, error, notFound. */
      readonly uiExports: readonly string[];
      readonly main: PruneResult;
      readonly ui: PruneResult;
    };

const UI_NAMES: readonly string[] = ["default", "pending", "error", "notFound"];

function isUiExport(name: string): boolean {
  return UI_NAMES.includes(name);
}

function isDirective(unit: Unit): boolean {
  return (
    unit.statement["directive"] !== undefined && typeof unit.statement["directive"] === "string"
  );
}

function isBareImport(unit: Unit): boolean {
  return unit.kind === "effect" && unit.statement.type === "ImportDeclaration";
}

/**
 * Splits a route module into its data half and its UI half.
 *
 * The data half keeps every non-UI export and what they need, and exports the UI names as lazy
 * components that import the UI half. The UI half keeps the UI exports and what they need, plus
 * the file's side-effect imports (styles). A module is left whole (`split: false`) when the halves
 * would have to share a module-level declaration (that would duplicate its state), when it has
 * other top-level side effects, or when it has no UI exports.
 *
 * @param source Original module text.
 * @param filename Path used for the language and for source maps.
 * @param uiSpecifier Import specifier of the UI half as seen from the data half, for example
 *   `./page.tsx?shadow-route=ui`.
 * @returns The two halves, or why the module stays whole.
 * @example
 * const result = splitRouteModule(code, "/app/src/routes/posts.tsx", "./posts.tsx?shadow-route=ui");
 * @since 1.0.0
 */
export function splitRouteModule(
  source: string,
  filename: string,
  uiSpecifier: string,
): RouteSplit {
  const module = parseModule(source, filename);
  const units = collectUnits(module);
  const uiExports = UI_NAMES.filter((name) =>
    units.units.some((unit) => unit.exports.includes(name)),
  );
  if (uiExports.length === 0) return { split: false, reason: "no-ui", detail: [] };
  if (units.units.some((unit) => unit.kind === "export-all")) {
    return { split: false, reason: "star-export", detail: [] };
  }
  const effects = units.units.filter(
    (unit) => unit.kind === "effect" && !isDirective(unit) && !isBareImport(unit),
  );
  if (effects.length > 0) return { split: false, reason: "side-effects", detail: [] };
  const mixed = units.units.filter(
    (unit) => unit.exports.some(isUiExport) && unit.exports.some((name) => !isUiExport(name)),
  );
  if (mixed.length > 0) {
    return { split: false, reason: "mixed-export", detail: mixed.flatMap((unit) => unit.exports) };
  }

  const isUiRoot = (unit: Unit): boolean =>
    unit.kind === "type" ||
    isDirective(unit) ||
    isBareImport(unit) ||
    unit.exports.some(isUiExport);
  const isDataRoot = (unit: Unit): boolean =>
    unit.kind === "type" ||
    isDirective(unit) ||
    (unit.exports.length > 0 && !unit.exports.some(isUiExport));

  const uiAlive = reachableUnits(units, units.units.filter(isUiRoot));
  const dataAlive = reachableUnits(units, units.units.filter(isDataRoot));
  const shared: string[] = [];
  for (const unit of units.units) {
    if (!uiAlive.has(unit.index) || !dataAlive.has(unit.index)) continue;
    if (unit.kind === "declarator" || unit.kind === "declaration") shared.push(...unit.declares);
  }
  if (shared.length > 0) {
    return { split: false, reason: "shared-declaration", detail: [...new Set(shared)].sort() };
  }

  const lazyLines: string[] = [];
  for (const name of uiExports) {
    const specifier = JSON.stringify(uiSpecifier);
    if (name === "default") {
      lazyLines.push(`export default $$shadowLazy(() => import(${specifier}));`);
    } else {
      lazyLines.push(
        `export const ${name} = $$shadowLazy(() => import(${specifier}).then((m) => ({ default: m.${name} })));`,
      );
    }
  }
  const main = pruneModule(module, {
    isRoot: isDataRoot,
    prepend: 'import { lazy as $$shadowLazy } from "@shadow-js/web";\n',
    append: `\n${lazyLines.join("\n")}\n`,
  });
  const ui = pruneModule(module, { isRoot: isUiRoot });
  return { split: true, uiExports, main, ui };
}
