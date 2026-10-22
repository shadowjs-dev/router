import { focusFragmentTarget } from "../internal/fragment";
import { withoutTrailingSlashes } from "../internal/links";
import { createScrollRestoration } from "../internal/scroll";
import type { RouterFeature } from "../types";

/**
 * The `scroll` feature: scroll restoration per history entry (a push scrolls to the top, or to the hash target once
 * it has rendered, a pop restores the saved position, a replace keeps it). A hash target that mounts later is looked
 * for on the next frames; a new page whose target never appears starts at the top. Positions are kept in session
 * storage too. Without a window (a memory router) it does nothing. Install it in `createRouter({ features })`.
 *
 * @example
 * import { scrollRestoration } from the "@shadow-js/router/scroll" subpath;
 * const router = createRouter({ routes, features: [scrollRestoration()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function scrollRestoration(): RouterFeature {
  return {
    id: "scroll",
    install(host): void {
      const win = host.window;
      if (win === undefined) return;
      const scroll = createScrollRestoration({
        window: win,
        currentIndex: host.currentIndex,
        storageKey: "shadow:router:scroll",
        schedule: (run: () => void): void => {
          queueMicrotask(run);
        },
        nextFrame: (run: () => void): void => {
          if (win.requestAnimationFrame === undefined) setTimeout(run, 16);
          else win.requestAnimationFrame(run);
        },
        focus: focusFragmentTarget,
        pageOf: (): string => {
          const location = host.history.location;
          return `${withoutTrailingSlashes(location.pathname)}${location.search}`;
        },
      });
      host.capabilities.scroll = scroll;
      host.onDispose(() => {
        scroll.dispose();
      });
    },
  };
}
