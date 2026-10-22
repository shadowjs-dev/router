/**
 * `@shadow-js/router`: the reactive layer of the router. Routes, the router, components and hooks.
 * The pure core (matching, history, navigation state machine) is in `@shadow-js/router/core`. Optional
 * capabilities are features, each in its own subpath: `@shadow-js/router/scroll`, `/loaders`, `/head`,
 * `/errors`, `/filters`, `/blockers`, `/transitions` and `/relative`.
 * @packageDocumentation
 */

export { A, type ABaseProps, type AProps, Navigate, type NavigateProps } from "./components/link";
export { Outlet } from "./components/outlet";
export { RouterProvider, type RouterProviderProps } from "./components/router-provider";
export { defineTemplate } from "./components/template";
export {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  isNotFound,
  isRedirect,
  notFound,
  redirect,
} from "./core/index";
export { type RuntimeHref, unsafeHref } from "./core/runtime-href";
export {
  type SearchIssue,
  SearchValidationError,
  type StandardSchemaLike,
} from "./core/search-validation";
export { createRouter } from "./create-router";
export { defineRoute } from "./define-route";
export {
  type FromOptions,
  useLoaderData,
  useMatch,
  useMatches,
  useParams,
  useSearch,
} from "./hooks/match";
export {
  type LocationView,
  type NavigationView,
  type SearchSetOptions,
  type SearchUpdate,
  useHref,
  useLocation,
  useNavigate,
  useNavigation,
  useRouter,
  useSearchParams,
} from "./hooks/navigation";
export { useOptionalRouter } from "./hooks/optional-router";
export { parseHydrationData, serializeHydrationData } from "./hydration";
export type {
  BlockedTransition,
  BlockerState,
  HrefOf,
  HydrationData,
  HydrationMatch,
  LoaderArgs,
  NavigateArgs,
  NavigateBaseOptions,
  NavigateOptionsFor,
  NavigateToOptions,
  OpenParamsOption,
  ParamsOption,
  ParamsView,
  PrefetchStrategy,
  Register,
  RegisteredPath,
  RenderedMatch,
  RouteArgs,
  RouteCacheOptions,
  RouteComponent,
  RouteDefinition,
  RouteErrorProps,
  RouteHeadInput,
  RouteHeadTag,
  RouteOptions,
  Router,
  RouterCacheOptions,
  RouterClock,
  RouterFeature,
  RouterFeatureId,
  RouterOptions,
  RouterPreloadOptions,
  RouterState,
  RouterWindow,
  SearchCodec,
} from "./types";
