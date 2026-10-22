import { decodeHash } from "../core/index";
import { focusFragmentTarget } from "../internal/fragment";
import { withoutTrailingSlashes } from "../internal/links";
import type { RouterFeature } from "../types";

/**
 * Options of {@link routeAnnouncer}.
 * @since 1.0.0
 */
export interface RouteAnnouncerOptions {
  /**
   * The text announced for a page that has neither a title nor an `h1`. A string is announced as it is written; a
   * function receives the page's path and returns the text (for a localized "Navigated to {path}"). Default: the path.
   */
  readonly fallback?: string | ((path: string) => string);
}

/**
 * The `announcer` feature: after a client navigation (a push, a replace to another page, or a back or forward
 * traversal) the new page is announced and focus moves to it.
 *
 * - A visually hidden live region (`role="status"`, `aria-live="polite"`, `aria-atomic="true"`) is added to the
 *   document body. Its text is the first of: the page title (`document.title`, which the page's `head` or `metadata`
 *   sets while the page renders), the text of the document's first `h1`, and a label for the path of the page
 *   (see {@link RouteAnnouncerOptions.fallback}). The text of the whole page is never announced.
 * - Focus moves to the element the URL's hash names when the page has one. Otherwise it moves to the page's first
 *   `h1` inside its `main` landmark, or to the `main` landmark when it has no heading. A non-interactive element
 *   gets `tabindex="-1"` while it has focus (and loses it on blur), so it can take focus without joining the tab
 *   order. Focus does not scroll the page: the scroll feature decides where the page starts.
 *
 * Nothing happens on the first page (the load is not a navigation), when only the hash changes, or when the URL
 * (path and query) is the same as the page on screen. A router without a window (a memory router on a server) gets
 * no region and no focus. The feature does not poll: it runs once per committed change.
 *
 * A hash target that mounts after the commit (a lazy view) is focused by the scroll feature when it appears; until
 * then the heading has focus.
 *
 * @example
 * import { routeAnnouncer } from "@shadow-js/router/announcer";
 * const router = createRouter({ routes, features: [routeAnnouncer({ fallback: (path) => `Navigated to ${path}` })] });
 * @param options See {@link RouteAnnouncerOptions}.
 * @returns The feature.
 * @since 1.0.0
 */
export function routeAnnouncer(options: RouteAnnouncerOptions = {}): RouterFeature {
  return {
    id: "announcer",
    install(host): void {
      if (host.window === undefined || typeof document === "undefined") return;
      const doc = document;
      const region = doc.createElement("div");
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "true");
      // Visually hidden, still read by assistive technology (the usual sr-only treatment).
      region.setAttribute(
        "style",
        "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap",
      );
      doc.body.appendChild(region);
      host.onDispose(() => {
        region.remove();
      });

      // The page on screen, as path and query. Undefined until the first page has committed.
      let shown: string | undefined;
      host.capabilities.announcer = (): void => {
        const location = host.history.location;
        // A trailing slash is the same page: the router's own replace that drops one (or adds one) is no navigation.
        const key = `${withoutTrailingSlashes(location.pathname)}${location.search}`;
        if (shown === undefined) {
          // The first page is loaded, not navigated to: nothing is announced and focus stays where it is.
          shown = key;
          return;
        }
        if (key === shown) return;
        shown = key;
        const heading = doc.querySelector("h1")?.textContent?.trim() ?? "";
        region.textContent =
          doc.title.trim() || heading || fallbackText(options, location.pathname);
        const hashTarget =
          location.hash === "" ? null : doc.getElementById(decodeHash(location.hash));
        const target = hashTarget ?? focusTargetOf(doc);
        if (target !== null && target !== undefined) focusFragmentTarget(target);
      };
    },
  };
}

/** The text announced when a page has neither a title nor a heading: the path, or what the app's `fallback` gives. */
function fallbackText(options: RouteAnnouncerOptions, path: string): string {
  const fallback = options.fallback;
  if (fallback === undefined) return path;
  return typeof fallback === "string" ? fallback : fallback(path);
}

/**
 * The element focus moves to: the first `h1` of the page's `main` landmark, else the `main` landmark itself. Without a
 * `main` landmark the document's first `h1` is used. Undefined when the page has neither.
 */
function focusTargetOf(doc: Document): HTMLElement | undefined {
  const main = doc.querySelector<HTMLElement>("main, [role='main']");
  const scope: ParentNode = main ?? doc;
  return scope.querySelector<HTMLElement>("h1") ?? main ?? undefined;
}
