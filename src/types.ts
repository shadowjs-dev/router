import type { HeadAttributeValue, HeadTagName } from "@shadow-js/web";
import type {
  BeforeLoadResult,
  History,
  InvalidateFilter,
  LoadIntent,
  NavigationOutcome,
  NavigationStatus,
  ParamFilter,
  ParamsOf,
  RouteLocation,
  SearchPatch,
  SearchRecord,
  WindowLike,
} from "./core/index";
import type { RuntimeHref } from "./core/runtime-href";
import type { SearchValidator } from "./core/search-validation";
import type { FeatureHost } from "./internal/capabilities";
import type { FragmentTarget } from "./internal/fragment";

/**
 * Augmentable registry. Declare your route paths once and every typed API (`A to`, `navigate`,
 * `useParams({ from })`, `useSearch({ from })`) accepts only those paths:
 *
 * @example
 * declare module "@shadow-js/router" {
 *   interface Register {
 *     paths: "/" | "/posts/:id";
 *   }
 * }
 * @since 1.0.0
 */
// biome-ignore lint/suspicious/noEmptyInterface: an empty interface is the augmentation point; a type alias cannot be merged
export interface Register {}

/** The route paths registered with {@link Register}, or `string` when nothing is registered. @since 1.0.0 */
export type RegisteredPath = Register extends { readonly paths: infer P extends string }
  ? P
  : string;

/** An empty path becomes `/`, so the root pattern and an optional-only root both give `/`. */
type NormalizeBase<B extends string> = B extends "" ? "/" : B;

/** One pattern segment, then the rest of the pattern, with `Acc` the path built so far. */
type PatternStep<
  Seg extends string,
  Rest extends string,
  Acc extends string,
> = Seg extends `:${string}?`
  ? PatternBase<Rest, Acc> | PatternBase<Rest, `${Acc}/${string}`>
  : Seg extends `:${string}`
    ? PatternBase<Rest, `${Acc}/${string}`>
    : Seg extends `*${string}`
      ? `${Acc}/${string}`
      : PatternBase<Rest, `${Acc}/${Seg}`>;

/**
 * Expands a route pattern into the path shapes it accepts, before any `?` or `#` tail. Literal
 * segments stay as written. Each `:param` and splat becomes `${string}`. An optional `:param?`
 * branches into a present and an absent variant.
 */
type PatternBase<P extends string, Acc extends string = ""> = P extends `${infer Seg}/${infer Rest}`
  ? Seg extends ""
    ? PatternBase<Rest, Acc>
    : PatternStep<Seg, Rest, Acc>
  : P extends ""
    ? Acc
    : P extends `:${string}?`
      ? Acc | `${Acc}/${string}`
      : P extends `:${string}`
        ? `${Acc}/${string}`
        : P extends `*${string}`
          ? `${Acc}/${string}`
          : `${Acc}/${P}`;

/**
 * The href a pattern produces: the expanded path (see {@link PatternBase}), optionally followed by a
 * `?` query or a `#` hash. Nothing else may follow the path, so `/posts/:id/edit` accepts
 * `/posts/7/edit`, `/posts/7/edit?tab=2` and `/posts/7/edit#top`, and refuses `/posts/7/delete`.
 */
type PatternHref<P extends string, B extends string = NormalizeBase<PatternBase<P>>> =
  | B
  | `${B}?${string}`
  | `${B}#${string}`;

/**
 * Targets accepted by typed navigation: a registered pattern (`/posts/:id`, used with `params`),
 * an href that matches one (`/posts/${string}`), or a {@link RuntimeHref} made by `unsafeHref` for a
 * path that was validated at run time. Plain `string` when no paths are registered.
 *
 * Limits: a `:param` or splat matches any text, including `/`, because TypeScript cannot exclude a
 * character from a template literal. A static pattern accepts `?` and `#` tails too, so `/about` also
 * takes `/about?tab=2` and `/about#team`.
 *
 * @example
 * ```ts
 * type Edit = HrefOf<"/posts/:id/edit">;
 * const ok: Edit = "/posts/7/edit?tab=2";
 * // @ts-expect-error the tail is /edit, not /delete
 * const bad: Edit = "/posts/7/delete";
 * ```
 * @since 1.0.0
 */
export type HrefOf<P extends string = RegisteredPath> = string extends P
  ? string
  : P | PatternHref<P> | RuntimeHref;

/** The params a pattern names. Unknown patterns give a loose record. @since 1.0.0 */
export type ParamsView<P extends string> = string extends P
  ? Readonly<Record<string, string | undefined>>
  : ParamsOf<P>;

/**
 * A route component. It is called with no meaningful props: read what it needs through the hooks.
 * @since 1.0.0
 */
export type RouteComponent = (props: never) => unknown;

/** Props passed to a route `error` component. @since 1.0.0 */
export interface RouteErrorProps {
  /** The thrown value. */
  readonly error: unknown;
  /**
   * Clears the error and rebuilds the route's content, without loading its data again. Also called automatically
   * on the next navigation. Use it when the route's render failed and its data is fine.
   */
  readonly reset: () => void;
  /**
   * Revalidates the route's loader (its cached data is dropped and loaded again), then clears the error and rebuilds
   * the route, as `reset` does. Use it when the route's data failed to load.
   */
  readonly retry: () => void;
}

/**
 * One head tag a route's `head` returns. It is the web package's `HeadTag` with a looser `tag`:
 * `export const head = () => [{ tag: "title", children: "Home" }]` is typed by TypeScript with
 * `tag: string` (a route module has no contextual type to keep the literal), so a plain object
 * literal must be accepted. The head registry checks every tag name when it applies the head: a
 * name it does not manage (`script`, a typo) throws there with a message naming the tag.
 * @since 1.0.0
 */
export interface RouteHeadTag {
  /** `"title" | "meta" | "link" | "style" | "base"`, or any string the registry will then reject. */
  readonly tag: HeadTagName | (string & Record<never, never>);
  readonly props?: Readonly<Record<string, HeadAttributeValue>>;
  readonly children?: string;
  readonly key?: string;
}

/** What a route's `head` returns: one tag, several, or nothing. @since 1.0.0 */
export type RouteHeadInput = RouteHeadTag | readonly RouteHeadTag[] | null | undefined | false;

/** What `beforeLoad` and `loader` receive for a route. @since 1.0.0 */
export interface RouteArgs<P extends string, S> {
  readonly params: ParamsView<P>;
  /** The validated search of this route (the parsed record when there is no validator). */
  readonly search: S;
  /** Context from the root down to this route, excluding this route's own additions. */
  readonly context: Readonly<Record<string, unknown>>;
  readonly location: RouteLocation;
  readonly intent: LoadIntent;
  /** Aborted when a newer navigation supersedes this one, or the router is disposed. */
  readonly signal: AbortSignal;
}

/** What `loader` receives: {@link RouteArgs} plus the loader deps. @since 1.0.0 */
export interface LoaderArgs<P extends string, S> extends RouteArgs<P, S> {
  readonly deps: unknown;
}

/** Options of {@link defineRoute}. @since 1.0.0 */
export interface RouteOptions<P extends string, S, L> {
  /** Route id. Defaults to the path. Required for a pathless route (`""`). */
  readonly id?: string;
  /** Child routes, with paths relative to this route. */
  readonly children?: readonly RouteDefinition[];
  /** Renders the route. Its `<Outlet />` shows the child route. */
  readonly component?: RouteComponent;
  /** Shown while navigating into this route, after `pendingMs`, when its data is not cached. */
  readonly pending?: () => unknown;
  /**
   * Delay, in ms, before this route's pending UI shows (Next's `loading.tsx` is immediate at `0`). It
   * applies to a navigation whose deepest matched route sets it, and to the children of a route that sets
   * it that do not set their own. Default: the router's `pendingMs` (1000).
   */
  readonly pendingMs?: number;
  /**
   * Shown in place of the route when its loader or component throws. Resets on navigation. Needs the
   * `errors` feature (`errorBoundaries()` from `@shadow-js/router/errors`).
   */
  readonly error?: (props: RouteErrorProps) => unknown;
  /**
   * Shown when `notFound()` is thrown at or below this route. A route with child routes (a
   * layout) stays on screen and this takes the place of its `<Outlet />`; a route without children
   * is replaced by it. A root layout's `notFound` is also what a URL that matches no route shows.
   */
  readonly notFound?: () => unknown;
  /**
   * Parses and validates the query: a function, or a Standard Schema (Zod, Valibot, ArkType) whose output is the typed
   * search. A throw fails the navigation (no commit); a rejected query throws `SearchValidationError`.
   */
  readonly validateSearch?: SearchValidator<S>;
  /** Extra keys of the loader cache, computed from the validated search. */
  readonly loaderDeps?: (search: S) => unknown;
  /**
   * Rules for the params of this path (`{ id: /^\d+$/ }`, `{ lang: ["en", "ar"] }`, a predicate or a
   * Standard Schema). A value that fails its rule does not match: the next route is tried, and a URL
   * with no matching route is not found. Links built with `params` are checked the same way.
   */
  /** Needs the `filters` feature (`matchFilters()` from `@shadow-js/router/filters`). */
  readonly matchFilters?: { readonly [K in keyof ParamsView<P>]?: ParamFilter };
  /** Runs top-down before the loaders, may add context, may throw `redirect()` / `notFound()`. */
  readonly beforeLoad?: (args: RouteArgs<P, S>) => BeforeLoadResult | Promise<BeforeLoadResult>;
  /**
   * Loads data for this route. Loaders run in parallel. Their result is `useLoaderData()`. Needs the
   * `loaders` feature (`loaderCache()` from `@shadow-js/router/loaders`).
   */
  readonly loader?: (args: LoaderArgs<P, S>) => L | Promise<L>;
  /**
   * Document head for this route, applied with `useHead` while the route is rendered. Needs the `head`
   * feature (`headManagement()` from `@shadow-js/router/head`).
   */
  readonly head?: (args: {
    readonly params: ParamsView<P>;
    readonly loaderData: L | undefined;
  }) => RouteHeadInput;
  /** Tags for future invalidation filters. */
  readonly tags?: readonly string[];
  /**
   * Where the route renders, read by the server handler of Dusk (the router itself does
   * not use it). `true` (the default): the server renders the route. `false`: the server sends the
   * empty document shell and the browser renders and loads everything. `"data-only"`: the server
   * runs the loaders and sends their data with an empty document, and the browser renders. In a
   * chain of matched routes the most restrictive value wins (`false`, then `"data-only"`).
   */
  readonly ssr?: boolean | "data-only";
  /**
   * What the server does with a param the page's `prerender` export does not list. `true` (the default): the page
   * renders on request. `false`: the server answers not found (a 404 with the app's not-found UI). Read by the
   * server handler of Dusk; the router itself does not use it, so a navigation in the browser is not refused. Written
   * by the generated route tree from `export const dynamicParams = true | false`, which needs a `prerender` export.
   */
  readonly dynamicParams?: boolean;
  /**
   * Seconds a server-rendered response of this page may be served from the ISR cache before it is
   * regenerated, or `false` to keep it until it is purged (`revalidatePath` / `revalidateTag`). Read
   * by the server handler of Dusk; the router itself does not use it. In a chain of matched
   * routes the shortest value wins.
   */
  readonly revalidate?: number | false;
  /**
   * Cache options of the page: `staleSeconds` (how long a stale response may still be served while it
   * is regenerated in the background), `cookies` (cookies the response may depend on; such requests are
   * cached per value) and `searchParams` (the query parameters that take part in the cache key; all
   * when omitted). Read by the server handler of Dusk.
   */
  readonly cache?: RouteCacheOptions;
  /**
   * `"blocking"` (the default) waits for a fresh loader result on navigation; `"background"`
   * shows the cached value at once and refreshes it without updating the screen.
   */
  readonly staleReload?: "background" | "blocking";
  /**
   * Document metadata exports (`metadata`, `generateMetadata`, `viewport`, `generateViewport`, `links`,
   * `meta`, `headers`). The router does not read them: a metadata feature (Dusk's `duskFeatures()`) does,
   * through the `metadata` capability. A route that exports one needs that feature. Written by the generator.
   * @internal
   */
  readonly metadata?: unknown;
  readonly generateMetadata?: unknown;
  /** The metadata of the not-found UI (`notFound`) of this route, merged over the chain of the 404 (see dusk-metadata). */
  readonly notFoundMetadata?: unknown;
  /** The metadata of the error UI (`error`) of this route, merged over the chain of an error status. */
  readonly errorMetadata?: unknown;
  readonly viewport?: unknown;
  readonly generateViewport?: unknown;
  readonly links?: unknown;
  readonly meta?: unknown;
  readonly headers?: unknown;
  /**
   * Set by the generated route tree when this route's chain runs server middleware (its own
   * `middleware` export, or a `_middleware` file in a folder above it). The middleware itself is
   * server-only and never reaches the client; the Dusk client asks the server to run it before a
   * navigation into the route. Written by the generator, not by hand.
   * @internal
   */
  readonly serverMiddleware?: boolean;
}

/**
 * A route built with {@link defineRoute}. Its typed helpers read the route's own params, search
 * and loader data without a `from` argument.
 * @since 1.0.0
 */
export interface RouteDefinition<P extends string = string, L = unknown, S = unknown> {
  /** The route id (the path unless the options set one). */
  readonly id: string;
  /** The route path, relative to the parent. */
  readonly path: P;
  /** Internal: the erased options the router reads. */
  readonly spec: RouteSpec;
  /** Typed params of this route, reactive. */
  readonly useParams: () => ParamsView<P>;
  /** Typed validated search of this route, reactive. */
  readonly useSearch: () => S;
  /** Accessor of this route's loader data. */
  readonly useLoaderData: () => () => L | undefined;
}

/** Internal erased form of a route's options. @since 1.0.0 */
export interface RouteSpec {
  readonly id: string;
  readonly path: string;
  readonly children: readonly RouteDefinition[];
  readonly component: RouteComponent | undefined;
  readonly pending: (() => unknown) | undefined;
  /** The route's `pendingMs` (see `RouteOptions.pendingMs`); `undefined` when it sets none. */
  readonly pendingMs: number | undefined;
  readonly error: ((props: RouteErrorProps) => unknown) | undefined;
  readonly notFound: (() => unknown) | undefined;
  readonly validateSearch: SearchValidator<unknown> | undefined;
  readonly loaderDeps: ((search: unknown) => unknown) | undefined;
  readonly matchFilters: Readonly<Record<string, ParamFilter>> | undefined;
  readonly beforeLoad:
    | ((args: RouteArgs<string, unknown>) => BeforeLoadResult | Promise<BeforeLoadResult>)
    | undefined;
  readonly loader: ((args: LoaderArgs<string, unknown>) => unknown) | undefined;
  readonly head:
    | ((args: { readonly params: unknown; readonly loaderData: unknown }) => RouteHeadInput)
    | undefined;
  readonly tags: readonly string[] | undefined;
  readonly ssr: boolean | "data-only" | undefined;
  /** The route's `dynamicParams` (see `RouteOptions.dynamicParams`); absent when it sets none. */
  readonly dynamicParams?: boolean | undefined;
  readonly revalidate: number | false | undefined;
  readonly cache: RouteCacheOptions | undefined;
  readonly staleReload: "background" | "blocking" | undefined;
  readonly serverMiddleware: boolean | undefined;
  /** Metadata exports, read by the metadata feature (see {@link RouteOptions.metadata}). */
  readonly metadata?: unknown;
  readonly generateMetadata?: unknown;
  /** The metadata of the not-found UI (`notFound`) of this route, merged over the chain of the 404 (see dusk-metadata). */
  readonly notFoundMetadata?: unknown;
  /** The metadata of the error UI (`error`) of this route, merged over the chain of an error status. */
  readonly errorMetadata?: unknown;
  readonly viewport?: unknown;
  readonly generateViewport?: unknown;
  readonly links?: unknown;
  readonly meta?: unknown;
  readonly headers?: unknown;
}

/**
 * The `cache` option of a page route. See {@link RouteOptions.cache}.
 * @since 1.0.0
 */
export interface RouteCacheOptions {
  /** Seconds a stale response may still be served while it regenerates. Default: the `revalidate` value. */
  readonly staleSeconds?: number;
  /** Cookies the response depends on. A request carrying other cookies is never served from the cache. */
  readonly cookies?: readonly string[];
  /** Query parameters that are part of the cache key. Default: all of them. */
  readonly searchParams?: readonly string[];
}

/** Search codec used when building hrefs from search objects. @since 1.0.0 */
export interface SearchCodec {
  stringify(record: SearchRecord): string;
}

/**
 * Time source and timers. Defaults to the global clock. Tests pass a fake one, so pending UI, GC
 * and blocking timers run on demand.
 * @since 1.0.0
 */
export interface RouterClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The window a router uses for popstate, scroll events and storage. It is a browser `window` or a
 * test double with the same members. Without one, the router is a memory router: no scroll
 * restoration and no listeners.
 * @since 1.0.0
 */
export interface RouterWindow extends WindowLike {
  readonly scrollX?: number;
  readonly scrollY?: number;
  readonly scrollTo?: ((x: number, y: number) => void) | undefined;
  readonly requestAnimationFrame?: ((callback: () => void) => unknown) | undefined;
  readonly history: WindowLike["history"] & { scrollRestoration?: "auto" | "manual" | undefined };
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  readonly sessionStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  readonly document?: {
    readonly getElementById?: ((id: string) => FragmentTarget | null) | undefined;
    readonly startViewTransition?:
      | ((
          update: (() => void) | { readonly update: () => void; readonly types?: string[] },
        ) => unknown)
      | undefined;
  };
  /** The `ViewTransition` class, present where transition types are supported. */
  readonly ViewTransition?: { readonly prototype: object } | undefined;
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
}

/** Loader cache limits. @since 1.0.0 */
export interface RouterCacheOptions {
  /** Hard cap on cached entries. Default 200. */
  readonly maxEntries?: number;
  /** Age after which a navigation refetches. Default 0 (always refetch on navigation). */
  readonly staleTime?: number;
  /** Age after which a preload refetches. Default 30 000 ms. */
  readonly preloadStaleTime?: number;
  /** Idle time before an entry is removed. Default 300 000 ms. */
  readonly gcTime?: number;
}

/**
 * An optional capability of a router (scroll restoration, loader caching, head management, ...). The
 * factories are exported from their own subpaths, so a router pays only for the ones it is given.
 * @example
 * import { scrollRestoration } from "@shadow-js/router/scroll";
 * const router = createRouter({ routes, features: [scrollRestoration()] });
 * @since 1.0.0
 */
export interface RouterFeature {
  /** The feature's name. A router takes each one at most once. */
  readonly id: RouterFeatureId;
  /** @internal Installs the capability into the router being built. */
  readonly install: (host: FeatureHost) => void;
}

/** The names of the features. @since 1.0.0 */
export type RouterFeatureId =
  | "scroll"
  | "loaders"
  | "head"
  | "errors"
  | "filters"
  | "blockers"
  | "transitions"
  | "prefetch"
  | "relative"
  | "announcer"
  | "link-status"
  | "metadata"
  | "search"
  | "not-found"
  | "pending";

/** Options of {@link createRouter}. @since 1.0.0 */
export interface RouterOptions {
  /** Top-level routes, built with {@link defineRoute}. */
  readonly routes: readonly RouteDefinition[];
  /** Where locations come from. Defaults to the browser history of `window`, or memory history. */
  readonly history?: History;
  /** Mount point, for example `/app`. Matched at a segment boundary only. */
  readonly base?: string;
  /** Trailing-slash policy. Default `"never"`. */
  readonly trailingSlash?: "never" | "always" | "preserve";
  /**
   * Static segments compare ASCII case exactly, so `/About` and `/about` are two routes. Default `false`. Must match
   * the scanner's `caseSensitive` (the build rejects two routes that differ only in case when it is false).
   */
  readonly caseSensitive?: boolean;
  /**
   * Which routes this router matches. `"public"` leaves out the private routes (a `_`-prefixed path): a server router
   * for a request from outside uses it. Default `"all"`, the browser router's behavior.
   */
  readonly visibility?: "public" | "all";
  /** Serializes search objects for links and `navigate`. Default: the core canonical form. */
  readonly searchCodec?: SearchCodec;
  /** Initial context at the root, added to by `beforeLoad`. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Delay before a pending UI is shown. Default 1000 ms. */
  readonly pendingMs?: number;
  /** Minimum time a pending UI stays visible once shown. Default 500 ms. */
  readonly pendingMinMs?: number;
  /**
   * Optional capabilities, each imported from its own subpath: `scrollRestoration()` from
   * `@shadow-js/router/scroll`, `loaderCache()` from `/loaders`, `headManagement()` from `/head`,
   * `errorBoundaries()` from `/errors`, `matchFilters()` from `/filters`, `blockers()` from
   * `/blockers`, `viewTransitions()` from `/transitions` and `relativeLinks()` from `/relative`.
   * A route that uses `loader`, `head`, `error` or `matchFilters` needs its feature here; a router
   * refuses such a route at creation and names the feature. Default: none (the smallest router).
   */
  readonly features?: readonly RouterFeature[];
  /** Clock and timers. Default: the global clock. */
  readonly clock?: RouterClock;
  /** The window for listeners, scroll and storage. Default: the global `window`, if any. */
  readonly window?: RouterWindow;
  /** Receives background failures: preload and subscriber errors. Default: rethrown later. */
  readonly onError?: (error: unknown) => void;
  /**
   * Maps the error a route's `error` component is shown for a render failure, before the component
   * receives it. Default: the error itself. A server maps it to a public error in production, so the
   * component cannot show a message the visitor should not see. Its result must not throw.
   */
  readonly presentError?: (error: unknown) => unknown;
  /** Maximum redirects in one navigation. Default 20. */
  readonly maxRedirects?: number;
  /** Maximum length of a query string, in UTF-16 units. Default 4096. */
  readonly maxSearchLength?: number;
}

/** The options of a navigation that do not depend on its target: everything except `params`. @since 1.0.0 */
export interface NavigateBaseOptions {
  /** Replace the current entry instead of pushing. */
  readonly replace?: boolean;
  /**
   * How a relative `to` (one that does not start with `/`) is resolved. `"path"`: against the
   * current pathname, as a directory (`edit` from `/posts/7` is `/posts/7/edit`). `"route"`: against
   * the pattern of the deepest route matched there, whose params are kept unless `params` overrides
   * them. Absolute targets are not changed. Default: the target is resolved as a URL against the
   * current location. Needs the `relative` feature (`relativeLinks()` from `@shadow-js/router/relative`).
   */
  readonly relative?: "path" | "route";
  /** Stored in `history.state` for the new entry. */
  readonly state?: unknown;
  /** Search to merge onto the target's own query, serialized with the codec. `undefined` removes a key. */
  readonly search?: SearchPatch;
  /** Hash to set, with or without `#`. */
  readonly hash?: string;
  /**
   * `false` commits this navigation without a view transition, even when the `transitions` feature is on. Default:
   * the navigation transitions. Ignored without that feature.
   */
  readonly viewTransition?: boolean | undefined;
}

/**
 * When a link loads its target ahead of a click (the `prefetch` feature): `"none"` never, `"intent"` on hover after a
 * short delay, keyboard focus and touch, `"viewport"` after the link has been visible for a moment, `"render"` as soon as
 * the link is on the page.
 * @since 1.0.0
 */
export type PrefetchStrategy = "none" | "intent" | "viewport" | "render";

/** Open `params`, for a target whose pattern is not known: any string values. @since 1.0.0 */
export interface OpenParamsOption {
  /** Values for the params of a pattern target (`/posts/:id`). */
  readonly params?: Readonly<Record<string, string>>;
}

/** Options of `navigate` and of `<A>` when the target is not a known literal pattern. @since 1.0.0 */
export interface NavigateToOptions extends NavigateBaseOptions, OpenParamsOption {}

/**
 * The `params` option a target needs. A literal pattern with params (`/posts/:id`) needs exactly its
 * params, typed (`{ id: string }`), and an unknown name is an error; the params of an optional segment
 * are optional, and a pattern with only optional params leaves `params` optional. A concrete href, a
 * `string`, a runtime href and a union of targets keep the open record.
 * @example
 * type PostParams = ParamsOption<"/posts/:id">; // { readonly params: { id: string } }
 * @since 1.0.0
 */
export type ParamsOption<P extends string> = [P] extends [never]
  ? OpenParamsOption
  : string extends P
    ? OpenParamsOption
    : [P] extends [RuntimeHref]
      ? OpenParamsOption
      : IsUnion<P> extends true
        ? OpenParamsOption
        : keyof ParamsOf<P> extends never
          ? OpenParamsOption
          : Partial<ParamsOf<P>> extends ParamsOf<P>
            ? { readonly params?: ParamsOf<P> }
            : { readonly params: ParamsOf<P> };

/** True for a union of two or more members. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** True when the target's `params` option has required keys. */
type NeedsParams<P extends string> =
  Partial<ParamsOption<P>> extends ParamsOption<P> ? false : true;

/**
 * The options of a navigation to `P`: the target-independent ones plus the {@link ParamsOption} of the
 * pattern. @since 1.0.0
 */
export type NavigateOptionsFor<P extends string> = NavigateBaseOptions & ParamsOption<P>;

/**
 * The rest parameters after the target: the options, required when the pattern has required params.
 * @since 1.0.0
 */
export type NavigateArgs<P extends string> =
  NeedsParams<P> extends true
    ? [options: NavigateOptionsFor<P>]
    : [options?: NavigateOptionsFor<P>];

/** A blocked transition, as a blocker sees it. @since 1.0.0 */
export interface BlockedTransition {
  readonly action: "PUSH" | "REPLACE" | "POP";
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly delta: number | undefined;
}

/** What {@link useBlocker} returns. @since 1.0.0 */
export interface BlockerState {
  /** `"blocked"` while a transition is held. */
  status(): "idle" | "blocked";
  /** The held transition, if any. */
  transition(): BlockedTransition | undefined;
  /** Lets the held transition through. */
  proceed(): void;
  /** Drops the held transition. */
  reset(): void;
}

/** One entry of the rendered match chain. @since 1.0.0 */
export interface RenderedMatch {
  readonly id: string;
  readonly pattern: string;
  readonly params: Readonly<Record<string, string>>;
  readonly loaderData: unknown;
  readonly depth: number;
  /** `route` for a matched route, `notFound` for the route that renders not-found UI. */
  readonly kind: "route" | "notFound";
}

/** Live state of the router, as accessors. @since 1.0.0 */
export interface RouterState {
  location(): RouteLocation | undefined;
  status(): NavigationStatus;
  /** True while a navigation is pending past `pendingMs`. */
  pending(): boolean;
  /** The last navigation error or not-found signal (`undefined` when none). */
  error(): unknown;
  /** The chain on screen, including the not-found route when one renders. */
  matches(): readonly RenderedMatch[];
}

/** JSON-serializable snapshot of loaded data. @since 1.0.0 */
export interface HydrationData {
  readonly version: 1;
  readonly matches: readonly HydrationMatch[];
}

/** One loader result in {@link HydrationData}. @since 1.0.0 */
export interface HydrationMatch {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
  readonly deps: unknown;
  readonly updatedAt: number;
  /** The loader result, or `{ error: message }` when the loader failed. */
  readonly value: unknown;
  readonly failed: boolean;
}

/**
 * The options of {@link Router.preload}: those of a navigation, plus a `signal` that releases the preload when it aborts.
 * @since 1.0.0
 */
export interface RouterPreloadOptions extends NavigateToOptions {
  /** Aborting it stops waiting for the loaders; a loader other consumers wait for keeps running. */
  readonly signal?: AbortSignal;
}

/** A router instance. @since 1.0.0 */
export interface Router {
  readonly state: RouterState;
  /** The history the router reads and writes. */
  readonly history: History;
  /**
   * Navigates. Resolves with the outcome; never throws for a redirect, not-found or cancel.
   * @example await router.navigate("/posts/7", { replace: true });
   */
  navigate(to: HrefOf, options?: NavigateToOptions): Promise<NavigationOutcome>;
  /** Loads the data of a target into the cache without changing the location. */
  preload(to: HrefOf, options?: RouterPreloadOptions): Promise<void>;
  /** Marks loader data stale (all, or the matching ids) and reloads the current location. */
  invalidate(filter?: InvalidateFilter): Promise<NavigationOutcome>;
  /** Loads the current location once. Hydrated data is used without refetching. */
  ready(): Promise<NavigationOutcome>;
  /** The href of a target, resolved against the current location and base. */
  href(to: HrefOf, options?: NavigateToOptions): string;
  /** Serializes the loaded data of the current matches. */
  dehydrate(): HydrationData;
  /** Seeds the loader cache from {@link Router.dehydrate} output. Call before {@link Router.ready}. */
  hydrate(data: HydrationData): void;
  /**
   * Seeds the loader cache with data the server sent for the current location (a single-flight answer)
   * and re-renders that location from it, without running its loaders again. Resolves with the outcome
   * of the render. Rejects with a TypeError for data that is not hydration data.
   */
  applyHydration(data: HydrationData): Promise<NavigationOutcome>;
  /** Stops listening, cancels timers and drops the loader cache. */
  dispose(): void;
}
