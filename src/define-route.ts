import { parsePattern, type SearchRecord } from "./core/index";
import { loaderHook, paramsHook, searchHook } from "./hooks/match";
import type { ParamsView, RouteDefinition, RouteOptions, RouteSpec } from "./types";

/**
 * Builds a typed route. The path is checked when the route is defined (an invalid pattern throws
 * here, not at the first navigation); the options' callbacks are typed by the path, so `params` in
 * `beforeLoad` and `loader` is `{ id: string }` for `/posts/:id`.
 *
 * @param path Route path, relative to the parent (`""` for a pathless layout, which then needs an
 *   explicit `id`).
 * @param options Components, search validation, loaders and children.
 * @returns The route, to pass to `createRouter` or to another route's `children`.
 * @throws TypeError for a pathless route without an id.
 * @throws PatternSyntaxError (from `@shadow-js/router/core`) for an invalid pattern.
 * @example
 * const post = defineRoute("/posts/:id", {
 *   loader: ({ params }) => fetchPost(params.id),
 *   component: () => <PostPage />,
 * });
 * @since 1.0.0
 */
export function defineRoute<P extends string, S = SearchRecord, L = undefined>(
  path: P,
  options: RouteOptions<P, S, L> = {},
): RouteDefinition<P, L, S> {
  const id = options.id ?? path;
  if (id === "")
    throw new TypeError(
      __DEV__ ? "defineRoute: a pathless route needs an explicit id" : "SHADOW_PATHLESS_ID",
    );
  parsePattern(path);
  // Erasure point: the router stores every route with the same spec type. The typed callbacks
  // only ever receive what the router passes them, which is the shape `RouteOptions` describes.
  const spec = { ...options, id, path, children: options.children ?? [] } as unknown as RouteSpec;
  return {
    id,
    path,
    spec,
    useParams: (): ParamsView<P> => paramsHook(id) as ParamsView<P>,
    useSearch: (): S => searchHook(id) as S,
    useLoaderData: (): (() => L | undefined) => {
      const read = loaderHook(id);
      return (): L | undefined => read() as L | undefined;
    },
  };
}
