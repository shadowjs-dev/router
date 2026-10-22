import { isNotFound, isRedirect, type NavigationRoute, type SearchRecord } from "../core/index";
import type { RouteDefinition, RouteSpec } from "../types";
import type { SearchRunner } from "./capabilities";
import { LoaderFailure } from "./failure";

/**
 * Converts the typed route definitions into the navigator's routes, and indexes them by id.
 *
 * Search validation runs once per location: the navigator's `validateSearch` call records the
 * result per (search object, route id), and the `loaderDeps` call reads it back. The record is a
 * WeakMap key, so entries go away with the search object.
 */

/** Routes of one router: the navigator tree and the erased specs by id. */
export interface RouteIndex {
  readonly tree: readonly NavigationRoute[];
  readonly specs: ReadonlyMap<string, RouteSpec>;
}

/** Validated search per parsed query object, per route id. */
export type ValidatedStore = WeakMap<SearchRecord, Map<string, unknown>>;

/** Runs a route's search validator (with `run`), or returns the raw record when it has none. */
export function validateFor(spec: RouteSpec, raw: SearchRecord, run: SearchRunner): unknown {
  return spec.validateSearch === undefined ? raw : run(spec.validateSearch, raw);
}

/** The loader deps of a route for a parsed query. `undefined` when the route has no deps. */
export function depsFor(spec: RouteSpec, raw: SearchRecord, run: SearchRunner): unknown {
  if (spec.loaderDeps === undefined) return undefined;
  return spec.loaderDeps(validateFor(spec, raw, run));
}

function recall(
  store: ValidatedStore,
  spec: RouteSpec,
  raw: SearchRecord,
  run: SearchRunner,
): unknown {
  const byId = store.get(raw);
  if (byId?.has(spec.id) === true) return byId.get(spec.id);
  return validateFor(spec, raw, run);
}

function remember(store: ValidatedStore, id: string, raw: SearchRecord, value: unknown): void {
  let byId = store.get(raw);
  if (byId === undefined) {
    byId = new Map<string, unknown>();
    store.set(raw, byId);
  }
  byId.set(id, value);
}

/**
 * Wraps one route's spec as a navigator route. A loader error becomes a {@link LoaderFailure} value
 * (redirects and not-found signals pass through), so the location commits and the error boundary
 * renders it.
 */
function toNavigationRoute(
  spec: RouteSpec,
  children: readonly NavigationRoute[],
  store: ValidatedStore,
  run: SearchRunner,
): NavigationRoute {
  const loader = spec.loader;
  const validate = spec.validateSearch;
  const wrappedLoader =
    loader === undefined
      ? undefined
      : async (args: Parameters<typeof loader>[0]): Promise<unknown> => {
          try {
            return await loader(args);
          } catch (error) {
            if (isRedirect(error) || isNotFound(error)) throw error;
            return new LoaderFailure(error);
          }
        };
  // A lazy component carries `preload`, which starts its chunk.
  const component = spec.component as { readonly preload?: unknown } | undefined;
  const preload = component?.preload;
  return {
    id: spec.id,
    path: spec.path,
    children,
    warm: typeof preload === "function" ? preload.bind(component) : undefined,
    ...(spec.matchFilters === undefined ? {} : { matchFilters: spec.matchFilters }),
    ...(spec.beforeLoad === undefined ? {} : { beforeLoad: spec.beforeLoad }),
    ...(wrappedLoader === undefined ? {} : { loader: wrappedLoader }),
    ...(validate === undefined
      ? {}
      : {
          validateSearch: (raw: SearchRecord): unknown => {
            const value = run(validate, raw);
            remember(store, spec.id, raw, value);
            return value;
          },
        }),
    ...(spec.loaderDeps === undefined
      ? {}
      : {
          loaderDeps: (raw: SearchRecord): unknown => {
            const loaderDeps = spec.loaderDeps;
            return loaderDeps?.(recall(store, spec, raw, run));
          },
        }),
    ...(spec.tags === undefined ? {} : { tags: spec.tags }),
    staleReload: spec.staleReload ?? "blocking",
  };
}

/**
 * Builds the navigator tree and the spec index. Iterative in the route depth, and rejects a route
 * id that appears twice (the navigator would report it as a conflict anyway, with less context).
 *
 * @throws TypeError when two routes share an id.
 */
export function buildRouteIndex(
  roots: readonly RouteDefinition[],
  store: ValidatedStore,
  run: SearchRunner,
): RouteIndex {
  const specs = new Map<string, RouteSpec>();
  const preorder: RouteSpec[] = [];
  const stack: RouteDefinition[] = [];
  for (let at = roots.length - 1; at >= 0; at -= 1) {
    const root = roots[at];
    if (root !== undefined) stack.push(root);
  }
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const spec = next.spec;
    if (specs.has(spec.id)) {
      throw new TypeError(
        __DEV__ ? `defineRoute: route id "${spec.id}" is used by two routes` : "SHADOW_ROUTE_ID",
      );
    }
    specs.set(spec.id, spec);
    preorder.push(spec);
    for (let at = spec.children.length - 1; at >= 0; at -= 1) {
      const child = spec.children[at];
      if (child !== undefined) stack.push(child);
    }
  }

  // Children come after their parent in preorder, so the reverse walk builds them first.
  const built = new Map<string, NavigationRoute>();
  for (let at = preorder.length - 1; at >= 0; at -= 1) {
    const spec = preorder[at];
    if (spec === undefined) continue;
    const children: NavigationRoute[] = [];
    for (const child of spec.children) {
      const node = built.get(child.id);
      if (node !== undefined) children.push(node);
    }
    built.set(spec.id, toNavigationRoute(spec, children, store, run));
  }
  const tree: NavigationRoute[] = [];
  for (const root of roots) {
    const node = built.get(root.id);
    if (node !== undefined) tree.push(node);
  }
  return { tree, specs };
}
