import { isServer, onCleanup, useMemo, useRenderEffect } from "@shadow-js/core";
import { element } from "@shadow-js/web";
import { isSafeNavigationTarget, normalizeNavigationText, type SearchPatch } from "../core/index";
import type { RouterCore } from "../internal/core";
import { comparablePath, isExternalTarget, joinClasses, pathOnly } from "../internal/links";
import { currentCore } from "../internal/render";
import type { HrefOf, NavigateToOptions, ParamsOption, PrefetchStrategy, Router } from "../types";

/**
 * The props of {@link A} that do not depend on its target. Attributes other than the ones listed pass to the anchor.
 * @since 1.0.0
 */
export interface ABaseProps {
  /** A raw href. Absolute URLs and other schemes are rendered as plain links. */
  readonly href?: string;
  /** Search merged onto the target's query. `undefined` removes a key. */
  readonly search?: SearchPatch;
  /** Hash for the target. */
  readonly hash?: string;
  /** Replace the current entry instead of pushing. */
  readonly replace?: boolean;
  /**
   * How a relative `to` resolves: `"path"` against the current pathname, `"route"` against the pattern of
   * the deepest route matched there. See {@link NavigateToOptions.relative}.
   */
  readonly relative?: "path" | "route";
  /** Stored in `history.state` for the new entry. */
  readonly state?: unknown;
  /** `false` commits this link's navigation without a view transition (needs the `transitions` feature). */
  readonly viewTransition?: boolean;
  /**
   * When the target loads ahead of a click. `"intent"` (default) on hover after 50 ms, focus or touch; `"viewport"`
   * once the link has been visible; `"render"` when the link mounts; `"none"` or `false` never. `"render"` and
   * `"none"` need the `prefetch()` feature; with it, the router's own default applies when this is not set.
   */
  readonly preload?: PrefetchStrategy | false;
  /** Class added while the target is the current location (or below it, unless `end`). */
  readonly activeClass?: string;
  /** Only the exact location counts as active. */
  readonly end?: boolean;
  readonly children?: unknown;
  readonly [attribute: string]: unknown;
}

/**
 * Props of {@link A}. `to` is a registered path or href, relative to the current location or absolute within the app. A
 * literal pattern with params (`/posts/:id`) needs exactly its `params`, typed from the pattern; see {@link ParamsOption}.
 * Without `to` (a raw `href`) `params` is the open record.
 * @since 1.0.0
 */
export type AProps<P extends HrefOf = never> = ABaseProps & {
  readonly to?: P;
} & ParamsOption<P>;

/** How a link resolves. */
type LinkTarget =
  | { readonly kind: "none" }
  | { readonly kind: "external"; readonly href: string }
  | {
      readonly kind: "route";
      readonly to: string;
      readonly options: NavigateToOptions;
      readonly href: string;
      readonly pathname: string;
    };

/** Delay of the hover preload, in milliseconds. */
const HOVER_PRELOAD_MS = 50;

/** Whether a link's `to` or `href` is a route, an external URL, or unusable. */
function describeLink(
  router: Router,
  text: string | undefined,
  options: NavigateToOptions,
): LinkTarget {
  if (text === undefined) return { kind: "none" };
  if (isExternalTarget(text.trim())) {
    return isSafeNavigationTarget(text.trim())
      ? { kind: "external", href: text.trim() }
      : { kind: "none" };
  }
  const normalized = normalizeNavigationText(text);
  if (normalized === undefined || !isSafeNavigationTarget(normalized)) return { kind: "none" };
  const href = router.href(normalized as HrefOf, options);
  return { kind: "route", to: normalized, options, href, pathname: pathOnly(href) };
}

/** Options of the navigation a click or a preload performs for this link. */
function optionsOf(props: {
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly search?: SearchPatch | undefined;
  readonly hash?: string | undefined;
  readonly replace?: boolean | undefined;
  readonly relative?: "path" | "route" | undefined;
  readonly state?: unknown;
  readonly viewTransition?: boolean | undefined;
}): NavigateToOptions {
  return {
    replace: props.replace === true,
    state: props.state,
    viewTransition: props.viewTransition,
    ...(props.params === undefined ? {} : { params: props.params }),
    ...(props.search === undefined ? {} : { search: props.search }),
    ...(props.hash === undefined ? {} : { hash: props.hash }),
    ...(props.relative === undefined ? {} : { relative: props.relative }),
  };
}

/** Calls a caller's event handler, in its plain or [handler, data] form. */
function callHandler(handler: unknown, event: MouseEvent): void {
  if (typeof handler === "function") {
    handler(event);
  } else if (Array.isArray(handler) && typeof handler[0] === "function") {
    handler[0](handler[1], event);
  }
}

/** True for a click the browser should handle itself: modified, not primary, or aimed elsewhere. */
function leavesToBrowser(
  event: MouseEvent,
  target: unknown,
  download: unknown,
  rel: unknown,
): boolean {
  if (event.defaultPrevented || event.button !== 0) return true;
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return true;
  if (typeof target === "string" && target !== "" && target !== "_self") return true;
  if (download !== undefined && download !== false) return true;
  return typeof rel === "string" && rel.split(/\s+/).includes("external");
}

/** Props `<A>` reads itself. Everything else is an attribute of the anchor. */
const OWN_PROPS: ReadonlySet<string> = new Set([
  "to",
  "href",
  "params",
  "search",
  "hash",
  "replace",
  "state",
  "preload",
  "viewTransition",
  "activeClass",
  "end",
  "relative",
  "children",
  "onClick",
  "onMouseEnter",
  "onMouseLeave",
  "onFocus",
  "onTouchStart",
  "ref",
  "class",
  "aria-current",
]);

/** Defines an enumerable getter: the attribute is read when the element binds it. */
function lazy(target: Record<string, unknown>, key: string, read: () => unknown): void {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get: read });
}

/**
 * A client-side anchor. Plain clicks navigate through the router; modified clicks, `target`,
 * `download`, `rel="external"`, absolute URLs and unsafe schemes are left to the browser. The
 * anchor reports its active state (`activeClass`, `aria-current="page"`) and preloads its target on
 * intent or when it scrolls into view.
 *
 * The anchor is built by `element` (from `@shadow-js/web`): attributes are bound one by one in render effects,
 * events are native listeners, and no generic prop runtime is linked. Server rendering writes the same markup as before,
 * with the same hydration keys.
 *
 * @param props See {@link AProps}.
 * @returns An `<a>` element (or its server markup).
 * @throws TypeError when rendered outside a `RouterProvider`.
 * @example
 * <A to="/posts/:id" params={{ id: "7" }} activeClass="current">Post 7</A>
 * @since 1.0.0
 */
export function A<P extends HrefOf = never>(props: AProps<P>): unknown {
  const core = currentCore("A");
  const router = core.router;
  // An explicit aria-current (even undefined) is the caller's choice; otherwise the active state decides.
  const explicitCurrent = "aria-current" in props;

  const link = useMemo<LinkTarget>(() => {
    const text = props.to ?? props.href;
    return describeLink(
      router,
      text,
      optionsOf(props as unknown as Parameters<typeof optionsOf>[0]),
    );
  });

  const active = useMemo<"exact" | "partial" | undefined>(() => {
    const current = link();
    const location = core.location();
    if (current.kind !== "route" || location === undefined) return undefined;
    const here = comparablePath(core.appPathname(location.pathname), core.caseSensitive);
    const there = comparablePath(core.appPathname(current.pathname), core.caseSensitive);
    if (here === there) return "exact";
    if (props.end !== true && there !== "/" && here.startsWith(`${there}/`)) return "partial";
    return undefined;
  });

  // With the `prefetch` feature it does all the preloading; without it, the built-in intent and viewport preload runs.
  const prefetch = core.capabilities.prefetch;
  const preloadMode = (): PrefetchStrategy | false | undefined =>
    prefetch === undefined ? (props.preload ?? "intent") : "none";
  const preloadNow = (): void => {
    const current = link();
    if (current.kind === "route") void router.preload(current.to as HrefOf, current.options);
  };

  let hover: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  onCleanup(() => {
    globalThis.clearTimeout(hover);
    stop?.();
  });

  const onClick = (event: MouseEvent): void => {
    // The caller's handler runs first, as Next's Link does; if it prevents the default, the router stays out.
    callHandler(props["onClick"], event);
    const current = link();
    if (current.kind !== "route") return;
    if (leavesToBrowser(event, props["target"], props["download"], props["rel"])) return;
    event.preventDefault();
    // The navigation starts whether or not the `link-status` feature follows it (an optional call would skip the argument).
    const navigation = router.navigate(current.to as HrefOf, current.options);
    core.capabilities.linkStatus?.track(onClick, navigation);
  };
  const onMouseEnter = (): void => {
    globalThis.clearTimeout(hover);
    if (preloadMode() === "intent") hover = globalThis.setTimeout(preloadNow, HOVER_PRELOAD_MS);
  };
  const onIntent = (): void => {
    if (preloadMode() === "intent") preloadNow();
  };
  const ref = (anchor: Element): void => {
    if (prefetch !== undefined) {
      stop = prefetch.attach(core, anchor, link, props);
    } else if (preloadMode() === "viewport" && typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        preloadNow();
        observer.disconnect();
      });
      observer.observe(anchor);
      stop = (): void => observer.disconnect();
    }
  };

  // Every attribute is read lazily, through a getter, so a reactive prop stays reactive. The attributes
  // keep the order they had before: the caller's own props in their order (with `class` and
  // `aria-current` where the caller wrote them), then the computed ones, then the children.
  const computed: Record<"href" | "class" | "aria-current", () => unknown> = {
    href: () => {
      const current = link();
      return current.kind === "none" ? undefined : current.href;
    },
    class: () =>
      joinClasses(props["class"], active() === undefined ? undefined : props.activeClass),
    "aria-current": () => {
      if (explicitCurrent) return props["aria-current"];
      return active() === "exact" ? "page" : undefined;
    },
  };
  const attributes: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (key === "class" || key === "aria-current") lazy(attributes, key, computed[key]);
    else if (!OWN_PROPS.has(key)) lazy(attributes, key, () => props[key]);
  }
  for (const key of ["href", "class", "aria-current"] as const) {
    if (!Object.hasOwn(attributes, key)) lazy(attributes, key, computed[key]);
  }
  lazy(
    attributes,
    "children",
    () => core.capabilities.linkStatus?.inside(onClick, () => props.children) ?? props.children,
  );
  Object.assign(attributes, {
    onClick,
    onMouseEnter,
    onMouseLeave: (): void => globalThis.clearTimeout(hover),
    onFocus: onIntent,
    onTouchStart: onIntent,
    ref,
  });

  return element("a", attributes);
}

/**
 * Navigates when it renders (in the browser). Renders nothing. Use it for redirects that depend on
 * app state; for redirects that depend on the route, `redirect()` in `beforeLoad` is the tool.
 *
 * @param props `to` and the options of `navigate`.
 * @returns `null`.
 * @since 1.0.0
 * @example <Navigate to="/login" replace />
 */
export function Navigate(props: NavigateProps): null {
  const core = currentCore("Navigate");
  if (!isServer) {
    const target = (): NavigateProps => ({
      to: props.to,
      params: props.params,
      search: props.search,
      hash: props.hash,
      replace: props.replace,
    });
    navigateOnRender(core, target);
  }
  return null;
}

/**
 * Props of {@link Navigate}.
 * @since 1.0.0
 */
export interface NavigateProps {
  readonly to: HrefOf;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly search?: SearchPatch | undefined;
  readonly hash?: string | undefined;
  readonly replace?: boolean | undefined;
}

/** Tracks the props and navigates whenever they change. */
function navigateOnRender(core: RouterCore, target: () => NavigateProps): void {
  useRenderEffect(target, (value) => {
    void core.router.navigate(value.to, optionsOf(value));
  });
}
