import { onCleanup, untrack, useSignal } from "@shadow-js/core";
import type { Transition } from "../core/index";
import type { BlockerRegistry } from "../internal/capabilities";
import type { TransitionGuard } from "../internal/core";
import { currentCore } from "../internal/render";
import type { BlockedTransition, BlockerState, RouterFeature } from "../types";

/**
 * The `blockers` feature: `useBlocker` holds navigations (push, replace, back and forward) while a
 * predicate says so, and `useBeforeLeave` runs a listener before each one. The router registers one
 * history blocker while a guard exists, so a router without guards pays nothing at run time. Install
 * the feature in `createRouter({ features })` to use either hook.
 *
 * @example
 * import { blockers, useBlocker } from the "@shadow-js/router/blockers" subpath;
 * const router = createRouter({ routes, features: [blockers()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function blockers(): RouterFeature {
  return {
    id: "blockers",
    install(host): void {
      const guards = new Set<TransitionGuard>();
      let release: (() => void) | undefined;
      /**
       * The single history blocker. It runs every guard and proceeds only when none holds. Every
       * guard sees the transition (listeners observe it even when another guard holds it).
       */
      const gate = (transition: Transition): void => {
        let held = false;
        // Untracked: a history change may start inside an effect, and the predicates read the app's state.
        for (const guard of [...guards]) {
          if (untrack(() => guard(transition)) === "hold") held = true;
        }
        if (!held) transition.proceed();
      };
      const registry: BlockerRegistry = {
        add(guard: TransitionGuard): () => void {
          guards.add(guard);
          release ??= host.history.block(gate);
          return (): void => {
            guards.delete(guard);
            if (guards.size === 0 && release !== undefined) {
              release();
              release = undefined;
            }
          };
        },
      };
      host.capabilities.guards = registry;
      host.onDispose(() => {
        release?.();
        release = undefined;
        guards.clear();
      });
    },
  };
}

/** The registry of the router a component renders under; throws when the feature is missing. */
function registryOf(hook: string): BlockerRegistry {
  const registry = currentCore(hook).capabilities.guards;
  if (registry === undefined) {
    throw new TypeError(
      `${hook}() needs the blockers feature: pass blockers() (from @shadow-js/router/blockers) in createRouter({ features })`,
    );
  }
  return registry;
}

/** Converts a history transition to the public view. */
function viewOf(transition: Transition): BlockedTransition {
  return {
    action: transition.action,
    pathname: transition.location.pathname,
    search: transition.location.search,
    hash: transition.location.hash,
    delta: transition.delta,
  };
}

/** A held transition and what the blocker showed of it. */
interface Held {
  readonly transition: Transition;
  readonly view: BlockedTransition;
}

/**
 * Holds navigations (push, replace and back/forward) while `shouldBlock` returns true. A held
 * transition waits in `status() === "blocked"` until `proceed()` lets it through or `reset()` drops
 * it. Removed when the component is disposed. Needs the `blockers` feature.
 *
 * Only in-app transitions are held. Closing the tab is not a router transition; use the browser's
 * `beforeunload` for that.
 *
 * @param shouldBlock Called for each transition. Return true to hold it.
 * @returns The blocker state.
 * @throws TypeError when the router was created without the `blockers` feature.
 * @since 1.0.0
 * @example
 * const blocker = useBlocker(() => form.dirty);
 * // when blocker.status() === "blocked", show a prompt that calls blocker.proceed() or reset()
 */
export function useBlocker(shouldBlock: (transition: BlockedTransition) => boolean): BlockerState {
  const registry = registryOf("useBlocker");
  const [held, setHeld] = useSignal<Held | undefined>(undefined, { equals: false });
  const release = registry.add((transition: Transition) => {
    const view = viewOf(transition);
    if (!shouldBlock(view)) return "allow";
    setHeld({ transition, view });
    return "hold";
  });
  onCleanup(release);
  return {
    status: (): "idle" | "blocked" => (held() === undefined ? "idle" : "blocked"),
    transition: (): BlockedTransition | undefined => held()?.view,
    proceed(): void {
      const current = held();
      if (current === undefined) return;
      setHeld(undefined);
      current.transition.proceed();
    },
    reset(): void {
      const current = held();
      if (current === undefined) return;
      setHeld(undefined);
      current.transition.cancel();
    },
  };
}

/** What a `useBeforeLeave` listener receives. @since 1.0.0 */
export interface BeforeLeaveEvent {
  /** The transition about to happen. */
  readonly transition: BlockedTransition;
  /** True once the listener called `preventDefault()`. */
  readonly defaultPrevented: boolean;
  /** Keeps the user here. The transition is held and dropped by the next navigation. */
  preventDefault(): void;
}

/**
 * Runs `listener` before every in-app transition. Calling `preventDefault()` keeps the user on the
 * current page. Removed when the component is disposed. Needs the `blockers` feature.
 *
 * @param listener Called synchronously for each transition.
 * @throws TypeError when the router was created without the `blockers` feature.
 * @since 1.0.0
 * @example
 * useBeforeLeave((event) => { if (form.dirty) event.preventDefault(); });
 */
export function useBeforeLeave(listener: (event: BeforeLeaveEvent) => void): void {
  const registry = registryOf("useBeforeLeave");
  const release = registry.add((transition: Transition) => {
    let prevented = false;
    const event: BeforeLeaveEvent = {
      transition: viewOf(transition),
      get defaultPrevented(): boolean {
        return prevented;
      },
      preventDefault(): void {
        prevented = true;
      },
    };
    listener(event);
    return event.defaultPrevented ? "hold" : "allow";
  });
  onCleanup(release);
}
