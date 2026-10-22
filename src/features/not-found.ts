import type { NotFoundCapability, NotFoundContext } from "../internal/capabilities";
import type { RenderedMatch, RouterFeature } from "../types";

/**
 * The `notFound` feature: the not-found UI of a route. A route that exports `notFound` (a component shown where
 * `notFound()` was thrown, or where no route matches) needs this feature in `createRouter({ features })`. The chain
 * logic lives here, not in the core, so an app with no not-found UI does not carry it.
 *
 * @example
 * import { notFoundUi } from "@shadow-js/router/not-found";
 * const router = createRouter({ routes, features: [notFoundUi()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function notFoundUi(): RouterFeature {
  return {
    id: "not-found",
    install(host): void {
      const capability: NotFoundCapability = { chain: notFoundChain };
      host.capabilities.notFound = capability;
    },
  };
}

/**
 * The rendered chain of a not-found result: the ancestors of the failing route plus the nearest route (at or above it)
 * that has a `notFound` component. A layout whose own data loaded (it is in `loaded`) stays on screen and its
 * `notFound` takes the place of what its outlet would show. A route without children, or a layout whose own loader or
 * `beforeLoad` failed (it has no data to render with), is replaced by its `notFound`. An unmatched path uses the first
 * root layout (see {@link rootNotFoundChain}). Empty when nothing can render it.
 */
function notFoundChain(context: NotFoundContext): RenderedMatch[] {
  const { pathname, routeId, loaded, matcher, specs, render } = context;
  const chain = matcher.match(pathname);
  if (chain.length === 0) return rootNotFoundChain(context);
  // The data the layouts above the failing route loaded (the navigator keeps it for a notFound).
  const dataOf = (id: string): unknown => loaded.find((match) => match.id === id)?.loaderData;
  let limit = chain.length - 1;
  if (routeId !== undefined) {
    const at = chain.findIndex((match) => match.id === routeId);
    if (at !== -1) limit = at;
  }
  for (let depth = limit; depth >= 0; depth -= 1) {
    const match = chain[depth];
    if (match === undefined) continue;
    const spec = specs.get(match.id);
    if (spec?.notFound === undefined) continue;
    const rendered: RenderedMatch[] = [];
    for (let at = 0; at < depth; at += 1) {
      const ancestor = chain[at];
      if (ancestor !== undefined)
        rendered.push(render(ancestor, "route", dataOf(ancestor.id), ancestor.params));
    }
    if (spec.children.length > 0 && loaded.some((ancestor) => ancestor.id === match.id)) {
      // A layout keeps its chrome and its data; its outlet shows the not-found content.
      rendered.push(render(match, "route", dataOf(match.id), match.params));
      rendered.push(render({ ...match, depth: depth + 1 }, "notFound", undefined, match.params));
    } else {
      rendered.push(render(match, "notFound", undefined, match.params));
    }
    return rendered;
  }
  return [];
}

/**
 * The chain of an unmatched path: the first top-level route that has no path of its own (a root layout), has child
 * routes and a `notFound` component, with that component in its outlet. Nothing renders when no route qualifies.
 */
function rootNotFoundChain(context: NotFoundContext): RenderedMatch[] {
  for (const route of context.routes) {
    const spec = route.spec;
    if (spec.path !== "" || spec.children.length === 0 || spec.notFound === undefined) continue;
    const layout = { id: spec.id, pattern: spec.path, params: {}, depth: 0 };
    return [
      context.render(layout, "route", undefined, layout.params),
      context.render({ ...layout, depth: 1 }, "notFound", undefined, layout.params),
    ];
  }
  return [];
}
