import { type Accessor, type Context, createContext } from "@shadow-js/core";
import type {
  History,
  NavigationStatus,
  RouteLocation,
  RouteMatcher,
  Transition,
} from "../core/index";
import type { RenderedMatch, Router, RouteSpec } from "../types";
import type { Capabilities } from "./capabilities";

/**
 * What the components and hooks need from one router instance. The public {@link Router} is the
 * object users hold; this is the reactive surface behind it, reachable only through the router
 * context and the registry in `create-router.ts`.
 */

/** What is shown at one depth of the tree. */
export type SlotKind = "none" | "route" | "notFound" | "pending";

/**
 * The content of one depth. `key` identifies it: the Outlet at that depth rebuilds its content only
 * when the key changes, so a navigation that keeps the same route (new params) keeps its layout.
 */
export interface Slot {
  readonly key: string;
  readonly kind: SlotKind;
  readonly depth: number;
  readonly entry: RenderedMatch | undefined;
  /** The `pending` component of a pending slot. */
  readonly pending: (() => unknown) | undefined;
}

/** Provided around the content of one slot, so hooks know their depth and route. */
export interface SlotInfo {
  readonly depth: number;
  readonly routeId: string | undefined;
  readonly kind: "route" | "notFound" | "pending";
}

/**
 * A guard decides about one history transition: `"allow"` lets it be considered allowed, `"hold"`
 * keeps it pending. The router runs every guard; any hold keeps the transition.
 */
export type TransitionGuard = (transition: Transition) => "allow" | "hold";

/** Where a navigation is heading, while it is in flight. */
export interface NavigationTarget {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** The reactive surface of one router. */
export interface RouterCore {
  readonly router: Router;
  readonly history: History;
  /** What a route's `error` component is shown for an error (see `RouterOptions.presentError`). */
  presentError(error: unknown): unknown;
  /** Erased spec of a route id. */
  specOf(id: string): RouteSpec | undefined;
  /** Whether static segments compare ASCII case (`RouterOptions.caseSensitive`). */
  readonly caseSensitive: boolean;
  /** The longest query string this router parses (`RouterOptions.maxSearchLength`). */
  readonly maxSearchLength: number;
  /** The pathname without the base path (what routes and links speak). */
  appPathname(pathname: string): string;
  /** Matches pathnames (with the base path) to routes. */
  readonly matcher: RouteMatcher;
  /** Content of one depth. Memoized per depth. */
  slotAt(depth: number): Accessor<Slot>;
  /** The rendered match at one depth. */
  entryAt(depth: number): Accessor<RenderedMatch | undefined>;
  /** Params of the rendered match at one depth. */
  paramsAt(depth: number): Accessor<Readonly<Record<string, string>> | undefined>;
  /** Depth of a rendered route id, or -1 when it is not on screen. */
  depthOf(id: string): Accessor<number>;
  /** Loader data at one depth. */
  loaderAt(depth: number): Accessor<unknown>;
  /** Validated search of the route at one depth. */
  searchAt(depth: number): Accessor<unknown>;
  /** Index of the deepest rendered match, or -1. */
  deepest(): Accessor<number>;
  /** The committed location. */
  location(): RouteLocation | undefined;
  /** Navigator status. */
  status(): NavigationStatus;
  /** True while a navigation is pending past `pendingMs`. */
  pending(): boolean;
  /** Where the navigation in flight is heading, if known. */
  target(): NavigationTarget | undefined;
  /** Registers an errored boundary's reset. Returns the unregister function. */
  registerReset(reset: () => void): () => void;
  /** The optional parts this router has (filled in by its features). */
  readonly capabilities: Capabilities;
}

/** The router a subtree renders under. */
export const RouterContext: Context<RouterCore | null> =
  /* @__PURE__ */ createContext<RouterCore | null>(null, {
    name: "Router",
  });

/** The route slot a subtree renders under. */
export const SlotContext: Context<SlotInfo | null> = /* @__PURE__ */ createContext<SlotInfo | null>(
  null,
  {
    name: "RouteSlot",
  },
);
