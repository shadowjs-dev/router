/**
 * `@shadow-js/router/core`: the pure router core. No DOM, no reactivity, no globals at import.
 * Everything here takes its clock, timers and window as parameters.
 */
export { canonicalKey } from "./canonical";
export {
  type Blocker,
  type BrowserHistory,
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  decodeHash,
  type History,
  type HistoryAction,
  type HistoryLocation,
  type HistoryOptions,
  type HistoryUpdate,
  type MemoryHistoryOptions,
  resolveLocation,
  type Transition,
  type WindowEventLike,
  type WindowLike,
} from "./history";
export {
  type CacheEntryView,
  createLoaderCache,
  type InvalidateFilter,
  type LoaderCache,
  type LoaderCacheOptions,
  type LoadIntent,
  type LoadRequest,
} from "./loader-cache";
export {
  comparePatterns,
  createMatcher,
  findConflicts,
  isPrivatePattern,
  type MatcherOptions,
  matchRoutes,
  type ParamFilter,
  type ParamSchema,
  type ParamSchemaResult,
  type RouteConflict,
  type RouteDefinition,
  type RouteMatch,
  type RouteMatcher,
  type RouteVisibility,
  restrictMatcher,
} from "./matcher";
export {
  type BeforeLoadArgs,
  type BeforeLoadResult,
  createNavigator,
  enableRedirectTargets,
  isNotFound,
  isRedirect,
  type LoaderArgs,
  type NavigateOptions,
  type NavigationMatch,
  type NavigationOutcome,
  type NavigationRoute,
  type NavigationSnapshot,
  type NavigationStatus,
  type Navigator,
  type NavigatorOptions,
  NotFoundSignal,
  notFound,
  type RedirectParams,
  RedirectSignal,
  type RedirectTarget,
  type RouteLocation,
  redirect,
} from "./navigation";
export {
  buildPath,
  buildPathFromParams,
  canonicalizePathname,
  decodeSegment,
  encodeSegment,
  expandOptionals,
  MAX_OPTIONAL_SEGMENTS,
  type ParamsOf,
  type ParsedPattern,
  type PatternSegment,
  PatternSyntaxError,
  parsePattern,
  resolvePath,
  splitPathname,
  type TrailingSlashPolicy,
} from "./path";
export { type RuntimeHref, unsafeHref } from "./runtime-href";
export {
  decodeSearchValue,
  isSearchWithinLimit,
  MAX_JSON_DEPTH,
  MAX_SEARCH_LENGTH,
  mergeSearch,
  type ParseSearchOptions,
  parseSearch,
  type SearchPatch,
  type SearchRecord,
  type SearchValue,
  stringifySearch,
} from "./search";
export { createSearchBatch, type SearchBatch } from "./search-batch";
export {
  runSearchValidator,
  type SearchIssue,
  SearchValidationError,
  type SearchValidator,
  type StandardSchemaLike,
  type StandardSchemaLikeResult,
} from "./search-validation";
export { SieveCache } from "./sieve";
export { isSafeNavigationTarget, normalizeNavigationText, resolveSameOrigin } from "./url-safety";
