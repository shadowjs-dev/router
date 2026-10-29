import {
  type Accessor,
  batch,
  createRoot,
  getOwner,
  type Owner,
  runWithOwner,
  untrack,
  useMemo,
  useSignal,
} from "@shadow-js/core";
import {
  buildPathFromParams,
  canonicalizePathname,
  createBrowserHistory,
  createMatcher,
  createMemoryHistory,
  createNavigator,
  type History,
  type HistoryAction,
  type HistoryUpdate,
  type InvalidateFilter,
  isNotFound,
  isSafeNavigationTarget,
  type LoaderCache,
  MAX_SEARCH_LENGTH,
  mergeSearch,
  type NavigationOutcome,
  type NavigationSnapshot,
  type NavigationStatus,
  type Navigator,
  normalizeNavigationText,
  parseSearch,
  type RouteLocation,
  type RouteMatch,
  type RouteMatcher,
  resolveLocation,
  restrictMatcher,
  type SearchPatch,
  type SearchRecord,
  stringifySearch,
} from "./core/index";
import {
  type Capabilities,
  type FeatureHost,
  type PendingUi,
  refuseSearch,
  UNCACHED_LOADERS,
} from "./internal/capabilities";
import type { NavigationTarget, RouterCore, Slot } from "./internal/core";
import { sameData } from "./internal/equal";
import { LoaderFailure } from "./internal/failure";
import { isExternalTarget } from "./internal/links";
import { toRendered } from "./internal/rendered";
import {
  buildRouteIndex,
  depsFor,
  type RouteIndex,
  type ValidatedStore,
  validateFor,
} from "./internal/route-tree";
import type {
  HydrationData,
  NavigateToOptions,
  RenderedMatch,
  Router,
  RouterClock,
  RouterFeature,
  RouterFeatureId,
  RouterOptions,
  RouterPreloadOptions,
  RouterWindow,
  RouteSpec,
} from "./types";

/**
 * The router instance: one navigator, one loader cache, one history and one batched subscription
 * that mirrors the navigator's snapshot into core signals. Every derived value (the rendered chain,
 * per-depth slots, per-depth params and search) is a memo owned by the router, so it lives exactly
 * as long as the router and is disposed with it.
 *
 * What is optional (scroll restoration, loader caching, head management, error boundaries, match
 * filters, blockers, view transitions and relative links) is not referenced here: a feature fills in
 * an entry of {@link Capabilities} when it is passed in `features`, and the core reads that entry where
 * the behavior needs it.
 */

/**
 * Where the navigation in flight is heading, and what was on screen when it started. The pending UI
 * is decided against the screen, so it stays up for `pendingMinMs` even after the new content is
 * committed.
 */
interface Routing extends NavigationTarget {
  readonly matches: readonly RouteMatch[];
  readonly screen: readonly RenderedMatch[];
}

const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({});
const SEARCH_LIMIT = MAX_SEARCH_LENGTH;
/** The router that owns each core. Weak, so a dropped router is collected. */
const cores = new WeakMap<Router, RouterCore>();

/** True when a route exports one of the metadata options (they need a metadata feature). */
function hasMetadataExports(spec: RouteSpec): boolean {
  return (
    spec.metadata !== undefined ||
    spec.generateMetadata !== undefined ||
    spec.notFoundMetadata !== undefined ||
    spec.errorMetadata !== undefined ||
    spec.viewport !== undefined ||
    spec.generateViewport !== undefined ||
    spec.links !== undefined ||
    spec.meta !== undefined ||
    spec.headers !== undefined
  );
}

/** The feature that a route option needs, and the factory that provides it. */
const REQUIREMENTS: readonly {
  readonly option:
    | "head"
    | "error"
    | "loader"
    | "matchFilters"
    | "metadata"
    | "validateSearch"
    | "notFound"
    | "pending";
  readonly feature: RouterFeatureId;
  readonly factory: string;
}[] = [
  {
    option: "head",
    feature: "head",
    factory: __DEV__ ? "headManagement() from @shadow-js/router/head" : "",
  },
  {
    option: "validateSearch",
    feature: "search",
    factory: __DEV__ ? "searchValidation() from @shadow-js/router/search" : "",
  },
  {
    option: "notFound",
    feature: "not-found",
    factory: __DEV__ ? "notFoundUi() from @shadow-js/router/not-found" : "",
  },
  {
    option: "pending",
    feature: "pending",
    factory: __DEV__ ? "pendingUi() from @shadow-js/router/pending" : "",
  },
  {
    option: "metadata",
    feature: "metadata",
    factory: __DEV__ ? "a metadata feature (Dusk: duskFeatures() includes it)" : "",
  },
  {
    option: "error",
    feature: "errors",
    factory: __DEV__ ? "errorBoundaries() from @shadow-js/router/errors" : "",
  },
  {
    option: "loader",
    feature: "loaders",
    factory: __DEV__ ? "loaderCache() from @shadow-js/router/loaders" : "",
  },
  {
    option: "matchFilters",
    feature: "filters",
    factory: __DEV__ ? "matchFilters() from @shadow-js/router/filters" : "",
  },
];

/**
 * The reactive core behind a router made by {@link createRouter}.
 *
 * @throws TypeError for any object that did not come from `createRouter`.
 * @internal
 */
export function coreOf(router: Router): RouterCore {
  const core = cores.get(router);
  if (core === undefined)
    throw new TypeError(
      __DEV__ ? "expected a router created by createRouter()" : "SHADOW_NOT_A_ROUTER",
    );
  return core;
}

/** The default `presentError`: the error is shown as it was thrown. */
function sameError(error: unknown): unknown {
  return error;
}

function systemClock(): RouterClock {
  return {
    now: (): number => Date.now(),
    setTimeout: (run: () => void, ms: number): unknown => globalThis.setTimeout(run, ms),
    clearTimeout: (handle: unknown): void => {
      globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
    },
  };
}

function defaultWindow(): RouterWindow | undefined {
  if (typeof window === "undefined") return undefined;
  // The browser window has every member RouterWindow names; TypeScript cannot see that through the
  // overloaded DOM signatures, so the cast is the one place the structural match is asserted.
  return window as unknown as RouterWindow;
}

/** The default error channel: a background failure is rethrown, never dropped. */
function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function sameEntry(a: RenderedMatch | undefined, b: RenderedMatch | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.depth === b.depth &&
    a.pattern === b.pattern &&
    Object.is(a.loaderData, b.loaderData) &&
    sameData(a.params, b.params)
  );
}

function sameChain(a: readonly RenderedMatch[], b: readonly RenderedMatch[]): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at += 1) {
    if (!sameEntry(a[at], b[at])) return false;
  }
  return true;
}

/**
 * Refuses a router whose features are given twice, or whose routes use an option that needs a
 * feature that is not given. Checked before anything is built, so the message names the route.
 */
function checkFeatures(features: readonly RouterFeature[], index: RouteIndex): void {
  const given = new Set<string>();
  for (const feature of features) {
    if (given.has(feature.id)) {
      throw new TypeError(
        __DEV__
          ? `createRouter: the "${feature.id}" feature is given more than once`
          : "SHADOW_FEATURE_TWICE",
      );
    }
    given.add(feature.id);
  }
  for (const spec of index.specs.values()) {
    for (const requirement of REQUIREMENTS) {
      if (given.has(requirement.feature)) continue;
      const used =
        requirement.option === "head"
          ? spec.head !== undefined
          : requirement.option === "error"
            ? spec.error !== undefined
            : requirement.option === "loader"
              ? spec.loader !== undefined
              : requirement.option === "metadata"
                ? hasMetadataExports(spec)
                : requirement.option === "validateSearch"
                  ? spec.validateSearch !== undefined
                  : requirement.option === "notFound"
                    ? spec.notFound !== undefined
                    : requirement.option === "pending"
                      ? spec.pending !== undefined
                      : spec.matchFilters !== undefined;
      if (used) {
        throw new TypeError(
          __DEV__
            ? `createRouter: route "${spec.id}" uses ${requirement.option}, which needs the "${requirement.feature}" feature; pass ${requirement.factory} in createRouter({ features })`
            : "SHADOW_FEATURE_MISSING",
        );
      }
    }
  }
}

/**
 * Creates a router.
 *
 * Nothing loads until {@link Router.ready} (or the `RouterProvider`, on the client) is called, so a
 * server can await the first load before rendering. Each router owns its listeners and timers;
 * {@link Router.dispose} removes them all.
 *
 * @param options Routes, features and policy. See {@link RouterOptions}.
 * @returns The router.
 * @throws Error when two routes match the same paths (the navigator's conflict report).
 * @throws TypeError when two routes share an id, a feature is given twice, or a route uses an option
 *   whose feature is not given.
 * @example
 * const router = createRouter({ routes: [home, posts], features: [scrollRestoration()] });
 * await router.ready();
 * @since 1.0.0
 */
export function createRouter(options: RouterOptions): Router {
  const clock = options.clock ?? systemClock();
  const now = (): number => clock.now();
  const setTimer = (run: () => void, ms: number): unknown => clock.setTimeout(run, ms);
  const clearTimer = (handle: unknown): void => {
    clock.clearTimeout(handle);
  };
  const win = options.window ?? defaultWindow();
  const base = options.base ?? "";
  const trailingSlash = options.trailingSlash ?? "never";
  const caseSensitive = options.caseSensitive ?? false;
  const report = options.onError ?? rethrowLater;
  const presentError = options.presentError ?? sameError;
  const codec = options.searchCodec ?? { stringify: stringifySearch };
  const context = options.context ?? EMPTY_CONTEXT;
  const maxRedirects = options.maxRedirects ?? 20;
  const maxSearchLength = options.maxSearchLength ?? SEARCH_LIMIT;
  const pendingMs = options.pendingMs ?? 1000;
  const pendingMinMs = options.pendingMinMs ?? 500;
  const features = options.features ?? [];

  const ownsHistory = options.history === undefined;
  const history: History =
    options.history ??
    (win === undefined
      ? createMemoryHistory({ initialEntries: ["/"] })
      : createBrowserHistory(win));

  const validated: ValidatedStore = new WeakMap();

  let committedIndex = history.location.index;
  let lastAction: HistoryAction = "REPLACE";
  let intended: NavigationTarget | undefined;
  let disposed = false;
  let readyPromise: Promise<NavigationOutcome> | undefined;
  let hydrated = false;
  let unsubscribe: () => void = () => undefined;
  let unlistenHistory: () => void = () => undefined;
  let disposeRoot: () => void = () => undefined;
  let routerOwner: Owner | null = null;

  // The optional parts of this router. Features fill them in before anything reads them.
  const capabilities: Capabilities = {};
  const disposers: (() => void)[] = [];
  const host: FeatureHost = {
    window: win,
    history,
    clock,
    report,
    currentIndex: (): number => committedIndex,
    capabilities,
    onDispose(run: () => void): void {
      disposers.push(run);
    },
  };
  for (const feature of features) feature.install(host);
  // Routes are built after the features are installed: a route's search validator is run by the feature that
  // provides it, so the index needs the runner the features chose (the core's refusal when none is given).
  const runSearch = capabilities.validateSearch ?? refuseSearch;
  const index = buildRouteIndex(options.routes, validated, runSearch);
  checkFeatures(features, index);

  const matcher: RouteMatcher = restrictMatcher(
    createMatcher(index.tree, {
      basePath: base,
      caseSensitive,
      ...(capabilities.compileFilter === undefined
        ? {}
        : { compileFilter: capabilities.compileFilter }),
    }),
    options.visibility ?? "all",
  );
  const loaderCache: LoaderCache = capabilities.loaders ?? UNCACHED_LOADERS;

  const navigator: Navigator = createNavigator({
    routes: index.tree,
    matcher,
    history,
    loaderCache,
    now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    basePath: base,
    caseSensitive,
    trailingSlash,
    maxRedirects,
    maxSearchLength,
    pendingMs,
    pendingMsOf: (routeId) => index.specs.get(routeId)?.pendingMs,
    pendingMinMs,
    context,
    onError: report,
  });

  /**
   * A load that did not navigate (initial load, hydration, invalidation) can still end at another
   * location, when a guard redirected it. The navigator does not write history for those loads, so
   * the URL would show the old location. Replacing the entry here keeps the URL and the screen in
   * step.
   */
  const syncLocation = (outcome: NavigationOutcome): NavigationOutcome => {
    if (outcome.kind !== "success") return outcome;
    const target = outcome.location;
    const current = history.location;
    if (
      target.pathname !== current.pathname ||
      target.search !== current.search ||
      target.hash !== current.hash
    ) {
      history.replace(`${target.pathname}${target.search}${target.hash}`);
    }
    return outcome;
  };

  /** The pathname, search and hash the history holds now. */
  const historyTarget = (): NavigationTarget => {
    const location = history.location;
    return { pathname: location.pathname, search: location.search, hash: location.hash };
  };

  /** Turns a target href into the location it would reach, or undefined when it is not routable. */
  const resolveTarget = (href: string): NavigationTarget | undefined => {
    const normalized = normalizeNavigationText(href);
    if (normalized === undefined || !isSafeNavigationTarget(normalized)) return undefined;
    const resolved = resolveLocation(history.location, normalized);
    const canonical = canonicalizePathname(resolved.pathname, trailingSlash);
    if (canonical === undefined) return undefined;
    const pathname = normalized.startsWith("/") ? matcher.addBase(canonical) : canonical;
    return { pathname, search: resolved.search, hash: resolved.hash };
  };

  /**
   * The target of a relative `to`. Resolved by the `relative` feature: `"path"` against the current
   * pathname as a directory, `"route"` against the pattern of the deepest route matched there (its
   * params are filled in, the params given override them). Absolute targets are not changed.
   */
  const anchored = (
    to: string,
    opts: NavigateToOptions,
  ): { to: string; params: Readonly<Record<string, string>> | undefined } => {
    if (opts.relative === undefined || to.startsWith("/") || isExternalTarget(to.trim())) {
      return { to, params: opts.params };
    }
    const resolve = capabilities.relative;
    if (resolve === undefined) {
      throw new TypeError(
        __DEV__
          ? `relative: "${opts.relative}" needs the "relative" feature; pass relativeLinks() (from @shadow-js/router/relative) in createRouter({ features })`
          : "SHADOW_FEATURE_MISSING",
      );
    }
    const here = matcher.stripBase(history.location.pathname) ?? "/";
    return resolve(to, opts, { here, matcher });
  };

  const buildTo = (rawTo: string, rawOpts: NavigateToOptions): string => {
    const resolved = anchored(rawTo, rawOpts);
    const to = resolved.to;
    const opts: NavigateToOptions =
      resolved.params === undefined ? rawOpts : { ...rawOpts, params: resolved.params };
    if (opts.params !== undefined) {
      // A link must name a URL the route would match: a value its matchFilters rule refuses is an error here.
      const failing = matcher.checkParams(to, opts.params);
      if (failing !== undefined) {
        throw new RangeError(
          __DEV__
            ? `param "${failing}" of "${to}" (value "${opts.params[failing] ?? ""}") fails its matchFilters rule; the route would not match this URL`
            : "SHADOW_FILTER_LINK",
        );
      }
    }
    const path = opts.params === undefined ? to : buildPathFromParams(to, opts.params);
    const hashAt = path.indexOf("#");
    let hash = hashAt < 0 ? "" : path.slice(hashAt);
    const beforeHash = hashAt < 0 ? path : path.slice(0, hashAt);
    const queryAt = beforeHash.indexOf("?");
    let query = queryAt < 0 ? "" : beforeHash.slice(queryAt);
    const pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
    if (opts.search !== undefined) {
      const patch: SearchPatch = opts.search;
      const merged = mergeSearch(parseSearch(query, { maxLength: maxSearchLength }), patch);
      query = codec.stringify(merged);
    }
    if (opts.hash !== undefined) {
      hash = opts.hash === "" ? "" : opts.hash.startsWith("#") ? opts.hash : `#${opts.hash}`;
    }
    return `${pathname}${query}${hash}`;
  };

  /** Chain of matches for a target, with its own search. */
  const routingFor = (target: NavigationTarget, screen: readonly RenderedMatch[]): Routing => ({
    ...target,
    matches: matcher.match(target.pathname),
    screen,
  });

  /** Whether any route being entered at or below `depth` has loader data that is not cached. */
  const enteringUncached = (target: Routing, depth: number): boolean => {
    if (target.search.length > maxSearchLength) return false;
    const raw = parseSearch(target.search, { maxLength: maxSearchLength });
    for (let at = depth; at < target.matches.length; at += 1) {
      const match = target.matches[at];
      const spec = match === undefined ? undefined : index.specs.get(match.id);
      if (match === undefined || spec === undefined || spec.loader === undefined) continue;
      const deps = untrack(() => depsFor(spec, raw, runSearch));
      if (loaderCache.peek(match.id, match.params, deps) === undefined) return true;
    }
    return false;
  };

  const failureIds = new WeakMap<LoaderFailure, number>();
  let nextFailureId = 0;
  const failureKey = (failure: LoaderFailure): number => {
    const known = failureIds.get(failure);
    if (known !== undefined) return known;
    nextFailureId += 1;
    failureIds.set(failure, nextFailureId);
    return nextFailureId;
  };

  const errored = new Set<() => void>();

  const router: Router = createRoot(
    (dispose) => {
      disposeRoot = dispose;
      routerOwner = getOwner();
      const memo = <T>(fn: () => T, equals?: (a: T, b: T) => boolean): Accessor<T> =>
        useMemo<T>(fn, equals === undefined ? undefined : { equals });
      /** Creates a per-depth memo once, owned by the router. */
      const perDepth = <T>(
        make: (depth: number) => Accessor<T>,
      ): ((depth: number) => Accessor<T>) => {
        const cache = new Map<number, Accessor<T>>();
        return (depth: number): Accessor<T> => {
          const known = cache.get(depth);
          if (known !== undefined) return known;
          const created = runWithOwner(routerOwner, () => make(depth));
          cache.set(depth, created);
          return created;
        };
      };

      const [snapshotSignal, setSnapshot] = useSignal<NavigationSnapshot>(navigator.getSnapshot(), {
        equals: false,
      });
      const [routing, setRouting] = useSignal<Routing | undefined>(undefined);

      // One memo per snapshot field: a reader of `pending` does not rerun on every publish.
      const locationOf = memo<RouteLocation | undefined>(() => snapshotSignal().location);
      const statusOf = memo<NavigationStatus>(() => snapshotSignal().status);
      const pendingOf = memo<boolean>(() => snapshotSignal().pending);
      const errorOf = memo<unknown>(() => snapshotSignal().error);

      const committedChain = memo<readonly RenderedMatch[]>(() => {
        const snapshot = snapshotSignal();
        if (isNotFound(snapshot.error)) {
          // Without the not-found feature nothing renders for a not-found result (see the feature).
          const location = snapshot.location;
          const notFound = capabilities.notFound;
          return location === undefined || notFound === undefined
            ? []
            : notFound.chain({
                pathname: location.pathname,
                routeId: snapshot.error.routeId,
                loaded: snapshot.matches,
                matcher,
                specs: index.specs,
                routes: options.routes,
                render: toRendered,
              });
        }
        return snapshot.matches.map((match) =>
          toRendered(match, "route", match.loaderData, match.params),
        );
      }, sameChain);

      // The pending UI is chosen by the `pending` feature; without it no route has a pending UI (checked at creation).
      const pendingUi = memo<PendingUi | undefined>(
        () => {
          const pending = capabilities.pending;
          if (pending === undefined || !pendingOf()) return undefined;
          const target = routing();
          if (target === undefined) return undefined;
          return pending.find({
            matches: target.matches,
            screen: target.screen,
            specs: index.specs,
            uncached: (depth: number): boolean => untrack(() => enteringUncached(target, depth)),
          });
        },
        (a, b) => capabilities.pending?.same(a, b) ?? a === b,
      );

      const entryAt = perDepth((depth) =>
        memo<RenderedMatch | undefined>(
          () => committedChain()[depth],
          (a, b) => sameEntry(a, b),
        ),
      );

      const slotAt = perDepth((depth): Accessor<Slot> => {
        const none: Slot = {
          key: `none:${depth}`,
          kind: "none",
          depth,
          entry: undefined,
          pending: undefined,
        };
        return memo<Slot>(
          () => {
            const pending = pendingUi();
            if (pending !== undefined) {
              if (depth === pending.depth) {
                return {
                  key: `pending:${pending.id}`,
                  kind: "pending",
                  depth,
                  entry: undefined,
                  pending: pending.component,
                };
              }
              if (depth > pending.depth) return none;
            }
            const entry = entryAt(depth)();
            if (entry === undefined) return none;
            const data = entry.loaderData;
            const state = data instanceof LoaderFailure ? `f${failureKey(data)}` : "ok";
            return {
              key: `${entry.kind}:${entry.id}:${state}`,
              kind: entry.kind,
              depth,
              entry,
              pending: undefined,
            };
          },
          (a, b) => a.key === b.key,
        );
      });

      const paramsAt = perDepth((depth) =>
        memo<Readonly<Record<string, string>> | undefined>(
          () => entryAt(depth)()?.params,
          sameData,
        ),
      );
      const loaderAt = perDepth((depth) => memo<unknown>(() => entryAt(depth)()?.loaderData));

      const depthById = new Map<string, Accessor<number>>();
      const depthOf = (id: string): Accessor<number> => {
        const known = depthById.get(id);
        if (known !== undefined) return known;
        const created = runWithOwner(routerOwner, () =>
          memo<number>(() => committedChain().findIndex((entry) => entry.id === id)),
        );
        depthById.set(id, created);
        return created;
      };

      const rawSearch = memo<SearchRecord>(() => {
        const location = locationOf();
        return parseSearch(location?.search ?? "", { maxLength: maxSearchLength });
      }, sameData);

      const searchAt = perDepth((depth) =>
        memo<unknown>(() => {
          const entry = entryAt(depth)();
          const spec = entry === undefined ? undefined : index.specs.get(entry.id);
          if (spec === undefined) return undefined;
          return validateFor(spec, rawSearch(), runSearch);
        }, sameData),
      );

      const deepest = memo<number>(() => committedChain().length - 1);

      const errorBoundaryReset = (): void => {
        for (const reset of [...errored]) reset();
      };

      const apply = (next: NavigationSnapshot, committed: boolean): void => {
        // The action of this change is read now: a transition may run the update later.
        const action = lastAction;
        if (committed) lastAction = "REPLACE";
        const update = (): void => {
          batch(() => {
            if (committed) errorBoundaryReset();
            setSnapshot(next);
          });
          // The batch has flushed the render and the head effects: the page on screen is the new one, so the
          // scroll (a hash target is looked up now, not before the commit) and the announcer see the new DOM.
          if (committed) {
            capabilities.scroll?.afterCommit(action, committedIndex, next.location?.hash ?? "");
            capabilities.announcer?.();
          }
        };
        // Only a committed change is a visual change; progress publishes update in place.
        const transition = capabilities.transition;
        if (committed && transition !== undefined) transition(update);
        else update();
      };

      let last: NavigationSnapshot = navigator.getSnapshot();
      // Untracked: the snapshot is published synchronously from `navigate()`, which an effect may be running, and
      // the reads below (the rendered chain) must not subscribe that effect.
      unsubscribe = navigator.subscribe((next: NavigationSnapshot) =>
        untrack(() => {
          const previous = last;
          last = next;
          const committed = next.location !== undefined && next.location !== previous.location;
          if (next.status === "matching") {
            // A navigation starts: remember where the screen was, and where it is heading. The action
            // of the change (PUSH, POP, REPLACE) is already recorded by the history listener, and a POP
            // fires before its navigation starts, so this must not reset it.
            capabilities.scroll?.remember(committedIndex);
            setRouting(routingFor(intended ?? historyTarget(), committedChain()));
          } else if (next.status === "idle" && !next.pending) {
            // The pending UI may outlive the commit (pendingMinMs), so the routing waits for it.
            setRouting(undefined);
          }
          if (committed) committedIndex = history.location.index;
          apply(next, committed);
        }),
      );

      unlistenHistory = history.listen((update: HistoryUpdate) => {
        lastAction = update.action;
      });

      // The loader data is carried by the `loaders` feature; without it no route has loader data to carry.
      const dehydrate = (): HydrationData => {
        const snapshot = navigator.getSnapshot();
        const location = snapshot.location;
        const hydration = capabilities.hydration;
        return {
          version: 1,
          matches:
            location === undefined || hydration === undefined
              ? []
              : hydration.dehydrate({
                  matches: snapshot.matches,
                  search: location.search,
                  specs: index.specs,
                  run: runSearch,
                  maxSearchLength,
                }),
        };
      };

      const built: Router = {
        state: {
          location: locationOf,
          status: statusOf,
          pending: pendingOf,
          error: errorOf,
          matches: committedChain,
        },
        history,
        // The methods that start work run untracked: `beforeLoad` and match filters are user code that the navigator
        // calls before its first await, so an effect that navigates must not subscribe to what they read.
        navigate(to: string, navigateOptions: NavigateToOptions = {}): Promise<NavigationOutcome> {
          return untrack(() => {
            const target = buildTo(to, navigateOptions);
            intended = resolveTarget(target);
            capabilities.skipTransition = navigateOptions.viewTransition === false;
            try {
              return navigator.navigate(target, {
                replace: navigateOptions.replace === true,
                state: navigateOptions.state,
              });
            } finally {
              intended = undefined;
            }
          });
        },

        preload(to: string, navigateOptions: RouterPreloadOptions = {}): Promise<void> {
          return untrack(() =>
            navigator.preload(buildTo(to, navigateOptions), navigateOptions.signal),
          );
        },

        invalidate(filter: InvalidateFilter = {}): Promise<NavigationOutcome> {
          return untrack(() => {
            loaderCache.invalidate(filter);
            return navigator.reload().then(syncLocation);
          });
        },

        ready(): Promise<NavigationOutcome> {
          if (readyPromise === undefined) {
            readyPromise = untrack(() =>
              (hydrated ? navigator.hydrate() : navigator.reload()).then(syncLocation),
            );
          }
          return readyPromise;
        },

        href(to: string, navigateOptions: NavigateToOptions = {}): string {
          return untrack(() => {
            const built = buildTo(to, navigateOptions);
            const target = resolveTarget(built);
            return target === undefined
              ? built
              : `${target.pathname}${target.search}${target.hash}`;
          });
        },

        dehydrate,

        hydrate(data: HydrationData): void {
          if (data.version !== 1 || !Array.isArray(data.matches)) {
            throw new TypeError(
              __DEV__ ? "hydrate(): unknown hydration data" : "SHADOW_HYDRATION_DATA",
            );
          }
          capabilities.hydration?.seed(data.matches, index.specs);
          hydrated = true;
        },

        applyHydration(data: HydrationData): Promise<NavigationOutcome> {
          try {
            built.hydrate(data);
          } catch (error) {
            return Promise.reject(error);
          }
          return navigator.hydrate().then(syncLocation);
        },

        dispose(): void {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          unlistenHistory();
          navigator.destroy();
          // The features release what they hold: the loader cache, the scroll listeners, the blockers.
          for (const release of disposers.splice(0)) release();
          errored.clear();
          if (ownsHistory) history.destroy();
          disposeRoot();
        },
      };

      cores.set(built, {
        router: built,
        history,
        capabilities,
        maxSearchLength,
        caseSensitive,
        specOf: (id: string) => index.specs.get(id),
        appPathname: (pathname: string) => matcher.stripBase(pathname) ?? pathname,
        matcher,
        slotAt,
        entryAt,
        paramsAt,
        depthOf,
        loaderAt,
        searchAt,
        deepest: () => deepest,
        location: locationOf,
        status: statusOf,
        pending: pendingOf,
        target: routing,
        registerReset(reset: () => void): () => void {
          errored.add(reset);
          return (): void => {
            errored.delete(reset);
          };
        },
        presentError,
      });
      return built;
    },
    { detached: true },
  );

  return router;
}
