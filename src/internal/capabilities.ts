import type { ErrorBoundaryProps } from "@shadow-js/web";
import type {
  History,
  LoaderCache,
  ParamFilter,
  RouteMatch,
  RouteMatcher,
  SearchRecord,
  SearchValidator,
} from "../core/index";
import type {
  HydrationMatch,
  NavigateToOptions,
  PrefetchStrategy,
  RenderedMatch,
  RouteDefinition,
  RouterClock,
  RouterWindow,
  RouteSpec,
} from "../types";
import type { RouterCore, TransitionGuard } from "./core";
import type { ScrollRestoration } from "./scroll";

/**
 * What a router can do beyond its core. Every optional capability is an entry here, filled in by a
 * feature (`@shadow-js/router/scroll`, `/loaders`, ...) while the router is built. The core reads an
 * entry only where the behavior needs it, so a feature that is not imported is not in the bundle:
 * nothing in the core refers to the code of a feature, only to this shape.
 */

/** A compiled param rule: true when the value passes. */
export type ParamPredicate = (value: string) => boolean;

/** Holds navigations while a guard says so. Filled by the `blockers` feature. */
export interface BlockerRegistry {
  /** Adds a guard. Returns the function that removes it. */
  add(guard: TransitionGuard): () => void;
}

/** Where a relative `to` is resolved: the pathname without the base, and the matcher. */
export interface RelativeContext {
  readonly here: string;
  readonly matcher: RouteMatcher;
}

/** Turns a relative `to` into an absolute pattern and params. Filled by the `relative` feature. */
export type RelativeResolver = (
  to: string,
  options: NavigateToOptions,
  context: RelativeContext,
) => { readonly to: string; readonly params: Readonly<Record<string, string>> | undefined };

/** Applies a route's `head` option. Filled by the `head` feature. */
export type HeadApplier = (
  core: RouterCore,
  depth: number,
  head: NonNullable<RouteSpec["head"]>,
) => void;

/** Applies the metadata exports of the routes on screen. Filled by a metadata feature. @internal */
export type MetadataApplier = (core: RouterCore, depth: number) => void;

/**
 * What a feature may use while it is installed: the router's window, history, clock and error channel,
 * the index of the entry on screen, the capabilities to fill, and a way to release what it holds.
 * @internal
 */
export interface FeatureHost {
  /** The window; undefined for a memory router. */
  readonly window: RouterWindow | undefined;
  readonly history: History;
  readonly clock: RouterClock;
  /** Receives background failures (the router's `onError`). */
  readonly report: (error: unknown) => void;
  /** The index of the history entry the page shows. */
  readonly currentIndex: () => number;
  /** The capabilities this router has; a feature sets its own entries. */
  readonly capabilities: Capabilities;
  /** Runs when the router is disposed. */
  onDispose(run: () => void): void;
}

/** The optional parts of one router. */
export interface Capabilities {
  /** The loader cache. Absent: loaders are not allowed (the router checks this at creation). */
  loaders?: LoaderCache;
  /** Scroll bookkeeping. Absent: no scroll restoration. */
  scroll?: ScrollRestoration;
  /** Applies a route's `head`. Absent: a route with `head` is refused at creation. */
  head?: HeadApplier;
  /**
   * Runs for every route body on screen, outermost first, after its `head`. A metadata feature reads the
   * chain from `core` and decides what to apply (the leaf applies the merged result). Absent: the metadata
   * exports are refused at creation.
   */
  metadata?: MetadataApplier;
  /** The error boundary of a route's `error` component. Absent: `error` is refused at creation. */
  boundary?: (props: ErrorBoundaryProps) => unknown;
  /** Compiles one `matchFilters` rule. Absent: `matchFilters` is refused at creation. */
  compileFilter?: (routeId: string, name: string, filter: ParamFilter) => ParamPredicate;
  /** The guards of blocked transitions. Absent: `useBlocker` and `useBeforeLeave` throw. */
  guards?: BlockerRegistry;
  /** Runs a committed change (for example inside a view transition). Absent: it runs directly. */
  transition?: (run: () => void) => void;
  /**
   * Set by every `navigate`: true when that navigation asked for no view transition (`viewTransition: false`). The
   * `transitions` feature reads it when the change commits. Absent or false: the change transitions.
   */
  skipTransition?: boolean;
  /** Loads link targets ahead of a click (the `prefetch` feature). Absent: `<A>` uses its built-in preloading. */
  prefetch?: PrefetchCapability;
  /** Resolves relative targets. Absent: a `relative` option throws. */
  relative?: RelativeResolver;
  /**
   * Runs after a committed change has rendered (the route is on screen and its head applied). The announcer
   * reads the title and moves focus here. Absent: nothing runs after a commit.
   */
  announcer?: () => void;
  /**
   * The pending state of links (the `link-status` feature). Absent: `<A>` neither tracks a click nor provides the
   * state to its children.
   */
  linkStatus?: LinkStatusCapability;
  /**
   * Runs a route's `validateSearch` (a function or a Standard Schema) on a parsed query. Filled by the `search`
   * feature. Absent: a route with `validateSearch` is refused at creation (see {@link refuseSearch}).
   */
  validateSearch?: SearchRunner;
  /** Renders not-found results (the `not-found` feature). Absent: a not-found result renders nothing. */
  notFound?: NotFoundCapability;
  /** Decides the pending UI of a navigation (the `pending` feature). Absent: no pending UI is shown. */
  pending?: PendingCapability;
  /** Dehydrates and seeds loader data (the `loaders` feature). Absent: there is no loader data to carry. */
  hydration?: HydrationCapability;
}

/** What a dehydration reads: the matched routes of the snapshot, the query, the route specs and the search runner. @internal */
export interface DehydrateContext {
  readonly matches: readonly {
    readonly id: string;
    readonly params: Readonly<Record<string, string>>;
  }[];
  readonly search: string;
  readonly specs: ReadonlyMap<string, RouteSpec>;
  readonly run: SearchRunner;
  readonly maxSearchLength: number;
}

/** Loader data a router carries to the client (and back): dehydrated from the cache, seeded into it. @internal */
export interface HydrationCapability {
  dehydrate(context: DehydrateContext): HydrationMatch[];
  seed(matches: readonly HydrationMatch[], specs: ReadonlyMap<string, RouteSpec>): void;
}

/** Runs one route's search validator on a parsed query. @internal */
export type SearchRunner = (validator: SearchValidator<unknown>, search: SearchRecord) => unknown;

/**
 * The search runner of a router without the `search` feature. The router refuses a route that exports `validateSearch`
 * at creation, so no validator reaches it; this is the guard should one ever do so.
 * @internal
 */
export const refuseSearch: SearchRunner = () => {
  throw new TypeError(
    __DEV__
      ? "validateSearch: the route validates its search, which needs the searchValidation() feature; pass it in createRouter({ features })"
      : "SHADOW_FEATURE_MISSING",
  );
};

/** The routes a not-found result is rendered in: the routes of the router and the matcher that found them. @internal */
export interface NotFoundContext {
  readonly pathname: string;
  readonly routeId: string | undefined;
  readonly loaded: readonly { readonly id: string; readonly loaderData: unknown }[];
  readonly matcher: RouteMatcher;
  readonly specs: ReadonlyMap<string, RouteSpec>;
  readonly routes: readonly RouteDefinition[];
  /** The rendered entry of a match in the given kind (the core's helper, so features build entries the same way). */
  readonly render: (
    match: RouteMatch,
    kind: RenderedMatch["kind"],
    loaderData: unknown,
    params: Readonly<Record<string, string>>,
  ) => RenderedMatch;
}

/** Renders the chain of a not-found result. Filled by the `not-found` feature. @internal */
export interface NotFoundCapability {
  chain(context: NotFoundContext): RenderedMatch[];
}

/** The pending UI chosen for a navigation: the depth it replaces, the route, and what it shows. @internal */
export interface PendingUi {
  readonly depth: number;
  readonly id: string;
  readonly component: () => unknown;
}

/** What the pending decision reads: the navigation's target, the screen, and the cache. @internal */
export interface PendingContext {
  readonly matches: readonly RouteMatch[];
  readonly screen: readonly RenderedMatch[];
  readonly specs: ReadonlyMap<string, RouteSpec>;
  /** True when a route entered at or below `depth` has loader data that is not cached. */
  readonly uncached: (depth: number) => boolean;
}

/** Chooses the pending UI of a navigation. Filled by the `pending` feature. @internal */
export interface PendingCapability {
  find(context: PendingContext): PendingUi | undefined;
  same(a: PendingUi | undefined, b: PendingUi | undefined): boolean;
}

/** A link target a prefetch loads. @internal */
export interface PrefetchTarget {
  readonly to: string;
  readonly options: NavigateToOptions;
  readonly pathname: string;
  readonly href: string;
}

/** What a link resolved to, as the `prefetch` feature reads it: a route target, or nothing to load. @internal */
export type PrefetchLink =
  | ({ readonly kind: "route" } & PrefetchTarget)
  | { readonly kind: "none" | "external" };

/** Loads the targets of anchors according to their strategy. Filled by the `prefetch` feature. @internal */
export interface PrefetchCapability {
  /**
   * Starts watching `anchor` per the strategy in `props.preload` (read when needed, so it may change). `link` is read
   * each time the target is needed. Returns the function that stops it and cancels what it started.
   */
  attach(
    core: RouterCore,
    anchor: Element,
    link: () => PrefetchLink,
    props: { readonly preload?: PrefetchStrategy | false | undefined },
  ): () => void;
}

/** Per-link pending state, filled by the `link-status` feature. @internal */
export interface LinkStatusCapability {
  /** Marks the link `key` as pending until `navigation` settles (commit, cancel or failure). */
  track(key: object, navigation: Promise<unknown>): void;
  /** Renders `children` inside the link `key`, so its content can read that link's pending state. */
  inside(key: object, children: () => unknown): unknown;
}

/**
 * The loader cache of a router without the `loaders` feature. The router refuses loaders at creation,
 * so no load reaches it; the reads answer "nothing cached", and the writes are no-ops.
 */
export const UNCACHED_LOADERS: LoaderCache = {
  load(): never {
    throw new TypeError(
      __DEV__
        ? "a loader ran without the loaders feature; pass loaderCache() in features"
        : "SHADOW_LOADERS_MISSING",
    );
  },
  seed(): void {
    throw new TypeError(
      __DEV__
        ? "hydrate: the loaders feature is needed to seed loader data"
        : "SHADOW_LOADERS_SEED",
    );
  },
  peek(): undefined {
    return undefined;
  },
  invalidate(): void {
    // Nothing is cached, so there is nothing to mark stale.
  },
  clearAll(): void {
    // Nothing is cached.
  },
  destroy(): void {
    // Nothing to release.
  },
  size: 0,
  inFlight: 0,
};
