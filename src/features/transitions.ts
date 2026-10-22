import { flushSync } from "@shadow-js/core";
import type { RouterFeature } from "../types";

/** The reduced-motion query: a view transition is skipped when the user asked for less motion. */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** The parts of a browser `ViewTransition` this feature uses. */
interface ViewTransitionLike {
  readonly finished?: Promise<unknown>;
  readonly ready?: Promise<unknown>;
  readonly updateCallbackDone?: Promise<unknown>;
  skipTransition?(): void;
}

/**
 * The `transitions` feature: committed changes run inside `document.startViewTransition` when the
 * browser has it and the user does not ask for reduced motion. Without the API, changes apply at once.
 *
 * - Where the browser supports transition types, each transition is typed `"forward"` (a push), `"back"` (a step back
 *   in history) or `"replace"`, so CSS can pick an animation with `:active-view-transition-type(back)`.
 * - A navigation that passes `viewTransition: false` commits without a transition.
 * - While a transition runs, the next commit applies at once instead of starting another; a commit that a newer one
 *   overtakes before its transition has started is dropped, so the screen never goes back to an older page.
 * - Disposing the router skips the running transition.
 *
 * @example
 * import { viewTransitions } from the "@shadow-js/router/transitions" subpath;
 * const router = createRouter({ routes, features: [viewTransitions()] });
 * await router.navigate("/settings", { viewTransition: false });
 * @returns The feature.
 * @since 1.0.0
 */
export function viewTransitions(): RouterFeature {
  return {
    id: "transitions",
    install(host): void {
      const win = host.window;
      const capabilities = host.capabilities;
      let generation = 0;
      let running: ViewTransitionLike | undefined;
      // How the history last moved: a push or a step forward, a step back, or a replace.
      let direction = "replace";
      let index = host.history.location.index;
      const unlisten = host.history.listen((update) => {
        const to = update.location.index;
        direction = update.action === "REPLACE" ? "replace" : to < index ? "back" : "forward";
        index = to;
        // A step through history is not a navigation of this app, so an earlier opt-out does not apply to it.
        if (update.action === "POP") capabilities.skipTransition = false;
      });
      host.onDispose(() => {
        unlisten();
        generation += 1;
        running?.skipTransition?.();
        running = undefined;
      });
      capabilities.transition = (run: () => void): void => {
        const doc = win?.document;
        const skip = capabilities.skipTransition === true;
        capabilities.skipTransition = false;
        const start = doc?.startViewTransition;
        const reduced = win?.matchMedia?.(REDUCED_MOTION)?.matches === true;
        // Every commit takes a number; an update that is not the newest one when its turn comes is stale.
        generation += 1;
        if (doc === undefined || start === undefined || reduced || skip || running !== undefined) {
          run();
          return;
        }
        const mine = generation;
        const update = (): void => {
          if (mine !== generation) return;
          run();
          flushSync();
        };
        const typed =
          win?.ViewTransition?.prototype !== undefined && "types" in win.ViewTransition.prototype;
        const transition = start.call(doc, typed ? { update, types: [direction] } : update) as
          | ViewTransitionLike
          | undefined;
        if (transition?.finished === undefined) return;
        running = transition;
        const done = (): void => {
          if (running === transition) running = undefined;
        };
        transition.finished.then(done, done);
        transition.ready?.catch(done);
        transition.updateCallbackDone?.catch(host.report);
      };
    },
  };
}
