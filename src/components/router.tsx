import { jsx, useStore, useEffect, onMount } from "@shadow-js/core";
import { compileRoutes, matchRoutes, type Match } from "../match";
import {
  pushActiveRouter,
  popActiveRouter,
  type ActiveRouter,
} from "../context";
import { withLeadingSlash, normalizeHref } from "../utils";
import { collectRoutesFromChildren } from "./route";
import {
  applyEnterTransition,
  getHashPathSearch,
  getHistoryPathSearch,
} from "./helpers";
import { Redirect } from "./redirect";
import type {
  ComponentType,
  RouteConfig,
  Transition,
  NavigateOptions,
  ScrollBehavior,
  ScrollContext,
} from "../types";

/**
 * Shadow Router - Declarative client-side routing for Shadow applications.
 *
 * Features:
 * - Declarative route configuration
 * - Nested routing with layouts
 * - URL hash and history modes
 * - Route transitions and animations
 * - Scroll restoration
 * - Programmatic navigation
 * - Route parameters and query strings
 *
 * @example
 * ```tsx
 * // Declarative routes
 * <Router>
 *   <Route path="/" component={Home} />
 *   <Route path="/about" component={About} />
 *   <Route path="/users/:id" component={UserProfile} />
 * </Router>
 *
 * // Programmatic routes
 * const routes = [
 *   { path: "/", component: Home },
 *   { path: "/about", component: About },
 *   { path: "/users/:id", component: UserProfile }
 * ];
 *
 * <Router routes={routes} />
 * ```
 */

/**
 * Router operating mode for URL handling.
 */
type RouterMode = "history" | "hash";

/**
 * Props for the Router component.
 */
type RouterProps = {
  /**
   * Optional array of route configurations. If provided, children are ignored.
   * Each route can have nested routes, layouts, and components.
   */
  routes?: RouteConfig[];
  /**
   * Optional child routes when using declarative routing.
   * Ignored if routes array is provided.
   */
  children?: any;
  /**
   * Default transition effect for route changes.
   * Can be overridden per route.
   */
  transition?: Transition;
  /**
   * Component to render when no routes match the current path.
   */
  notFound?: ComponentType<any>;
  /**
   * URL handling mode: "history" for clean URLs, "hash" for hash-based routing.
   */
  mode?: RouterMode;
  /**
   * Scroll behavior for navigation. Can be "auto", "top", or custom function.
   */
  scroll?: ScrollBehavior;
};

/**
 * Internal component that wraps route content with transition effects.
 * Applies the specified transition animation when the component mounts.
 */
function Leaf(props: { children?: any; transition: Transition }) {
  const ref = { current: null as null | HTMLElement };
  onMount(() => {
    if (ref.current) applyEnterTransition(ref.current, props.transition);
  });
  return (
    <div data-shadow-router-view ref={ref}>
      {props.children}
    </div>
  );
}

/**
 * Main Router component that manages client-side routing for Shadow applications.
 *
 * This component:
 * 1. Compiles route configurations from props.routes or props.children
 * 2. Manages browser history and hash changes
 * 3. Tracks current route matches and parameters
 * 4. Handles navigation programmatically and via browser back/forward
 * 5. Provides scroll restoration and route transitions
 * 6. Renders matched route components with proper nesting and layouts
 *
 * The router automatically becomes the active router context for child components,
 * allowing hooks like useLocation, useParams, etc. to work properly.
 *
 * @param props Router configuration props
 * @returns JSX element containing the router view
 */
export function Router(props: RouterProps) {
  // Compile routes from either routes array or children
  const routeList =
    (props.routes && props.routes.length && props.routes) ||
    collectRoutesFromChildren(props.children) ||
    [];
  const compiled = compileRoutes(routeList);
  const defaultTransition: Transition = props.transition ?? "fade";
  const mode: RouterMode = props.mode ?? "history";

  // Initialize current location state
  const initialPS =
    mode === "hash" ? getHashPathSearch() : getHistoryPathSearch();

  // Reactive stores for current navigation state
  const [path, setPath] = useStore<string>(initialPS.pathname);
  const [search, setSearch] = useStore<string>(initialPS.search);
  const [state, setState] = useStore<any>(history.state ?? null);
  const [match, setMatch] = useStore<Match | null>(
    matchRoutes(compiled, initialPS.pathname)
  );

  // Scroll restoration system
  const scrollBehavior: ScrollBehavior = props.scroll ?? "auto";
  const positions = new Map<number, { x: number; y: number }>();
  let seq = (history.state && (history.state as any).__srk) || 0;

  /**
   * Ensures each history entry has a unique key for scroll restoration.
   */
  function ensureEntryKey() {
    const st = (history.state as any) ?? {};
    if (!st.__srk) {
      seq += 1;
      history.replaceState({ ...st, __srk: seq }, "", window.location.href);
      setState({ ...st, __srk: seq });
    } else {
      seq = Math.max(seq, st.__srk);
    }
  }
  ensureEntryKey();

  /**
   * Gets the current history entry's unique key for scroll tracking.
   */
  function currentKey(): number {
    const st = (history.state as any) ?? {};
    return st.__srk || 0;
  }

  /**
   * Saves current scroll position for the current history entry.
   */
  function saveScroll() {
    positions.set(currentKey(), { x: window.scrollX, y: window.scrollY });
  }

  /**
   * Restores scroll position for a specific history entry key.
   */
  function restoreScrollForKey(k: number) {
    const pos = positions.get(k);
    if (pos) window.scrollTo(pos.x, pos.y);
  }

  /**
   * Navigation action type for tracking how navigation occurred.
   */
  type NavAction = "PUSH" | "REPLACE" | "POP";
  let lastAction: NavAction = "PUSH";

  /**
   * Programmatic navigation function that updates the URL and router state.
   * Supports both history and hash modes, with optional state and scroll behavior.
   *
   * @param to - Target URL/path to navigate to
   * @param opts - Navigation options (replace, state, etc.)
   */
  const navigate = (to: string, opts?: NavigateOptions) => {
    const href = normalizeHref(to);
    const base = window.location.origin + (mode === "hash" ? "/#" : "/");
    const u = new URL(href, base);

    const nextPath =
      mode === "hash"
        ? withLeadingSlash((u.hash.slice(1).split("?")[0] || "/") as string)
        : withLeadingSlash(u.pathname);
    const nextSearch =
      mode === "hash" ? u.hash.slice(1).split("?")[1] || "" : u.search;
    const nextSearchStr =
      nextSearch && !nextSearch.startsWith("?") ? `?${nextSearch}` : nextSearch;

    const nextState = opts?.state ?? null;

    const nothingChanged =
      path() === nextPath &&
      search() === nextSearchStr &&
      state() === nextState;

    saveScroll();

    if (mode === "history") {
      if (opts?.replace) {
        lastAction = "REPLACE";
        history.replaceState(nextState, "", nextPath + nextSearchStr);
      } else if (!nothingChanged) {
        lastAction = "PUSH";
        seq += 1;
        history.pushState(
          { ...nextState, __srk: seq },
          "",
          nextPath + nextSearchStr
        );
      }
    } else {
      const hashTarget = "#" + (withLeadingSlash(nextPath) + nextSearchStr);
      if (opts?.replace) {
        lastAction = "REPLACE";
        history.replaceState(nextState, "", hashTarget);
      } else if (!nothingChanged) {
        lastAction = "PUSH";
        seq += 1;
        history.pushState({ ...nextState, __srk: seq }, "", hashTarget);
      }
    }

    if (!nothingChanged) {
      setPath(nextPath);
      setSearch(nextSearchStr);
      setState(opts?.replace ? nextState : { ...nextState, __srk: seq });

      queueMicrotask(() => {
        if (typeof scrollBehavior === "function") {
          const ctx: ScrollContext = {
            action: lastAction,
            from: { pathname: path(), search: search() },
            to: { pathname: nextPath, search: nextSearchStr },
          };
          try {
            scrollBehavior(ctx);
          } catch {}
        } else if (scrollBehavior === "top") {
          window.scrollTo(0, 0);
        } else if (scrollBehavior === "auto") {
          if (lastAction === "PUSH") window.scrollTo(0, 0);
        }
      });
    }
  };

  useEffect(() => {
    setMatch(matchRoutes(compiled, path()));
  });

  useEffect(() => {
    const handler = () => {
      lastAction = "POP";
      saveScroll();
      const parts =
        mode === "hash" ? getHashPathSearch() : getHistoryPathSearch();
      setPath(parts.pathname);
      setSearch(parts.search);
      setState(history.state ?? null);

      const key = currentKey();
      requestAnimationFrame(() => {
        if (typeof scrollBehavior === "function") {
          const ctx: ScrollContext = {
            action: "POP",
            from: { pathname: "", search: "" },
            to: { pathname: parts.pathname, search: parts.search },
          };
          try {
            scrollBehavior(ctx);
          } catch {}
        } else if (scrollBehavior === "auto") {
          restoreScrollForKey(key);
        } else if (scrollBehavior === "top") {
          window.scrollTo(0, 0);
        }
      });
    };

    window.addEventListener("popstate", handler);
    if (mode === "hash") window.addEventListener("hashchange", handler);
    return () => {
      window.removeEventListener("popstate", handler);
      if (mode === "hash") window.removeEventListener("hashchange", handler);
    };
  });

  const active: ActiveRouter = {
    compiled,
    path,
    search,
    state,
    match,
    navigate,
    transition: defaultTransition,
    mode,
    notFoundComponent: props.notFound,
  };

  onMount(() => pushActiveRouter(active));
  useEffect(() => {
    return () => {
      popActiveRouter(active);
    };
  });

  const view = () => {
    const m = match();

    if (m) {
      const leaf = m.chain[m.chain.length - 1]!;
      if (leaf.redirect) {
        const to =
          typeof leaf.redirect === "function"
            ? leaf.redirect(m.params)
            : leaf.redirect;
        return jsx(Redirect, { to });
      }

      let node: any = leaf.component ? jsx(leaf.component, {}) : null;
      for (let i = m.chain.length - 1; i >= 0; i--) {
        const r = m.chain[i]!;
        if (r.layout) {
          node = jsx(r.layout, { children: node });
        }
      }
      return jsx(Leaf, {
        transition: leaf.transition ?? active.transition,
        children: node,
      });
    }

    if (active.notFoundComponent) {
      return jsx(Leaf, {
        transition: active.transition,
        children: jsx(active.notFoundComponent, {}),
      });
    }
    return document.createDocumentFragment();
  };

  return <div data-shadow-router>{view}</div>;
}
