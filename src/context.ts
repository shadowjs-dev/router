import type { CompiledRoute, Match } from "./match";
import type { NavigateOptions, Transition } from "./types";
import type { Store } from "@shadow-js/core";

export type ActiveRouter = {
  compiled: CompiledRoute[];
  path: Store<string>;
  search: Store<string>;
  state: Store<any>;
  match: Store<Match | null>;

  navigate: (to: string, opts?: NavigateOptions) => void;
  transition: Transition;
  mode: "history" | "hash";
  notFoundComponent?: (props?: any) => any;
};

// --- Active router stack management ---

let ACTIVE: ActiveRouter | null = null;
const STACK: ActiveRouter[] = [];

/**
 * Push a router instance as the current active router.
 */
export function pushActiveRouter(r: ActiveRouter) {
  STACK.push(r);
  ACTIVE = r;
}

/**
 * Pop a router instance from the stack.
 * If it was the top, the next one becomes active.
 */
export function popActiveRouter(r: ActiveRouter) {
  const idx = STACK.lastIndexOf(r);
  if (idx !== -1) STACK.splice(idx, 1);
  ACTIVE = STACK[STACK.length - 1] || null;
}

/**
 * Legacy setter (not recommended).
 * Clears or replaces the stack.
 */
export function setActiveRouter(r: ActiveRouter | null) {
  ACTIVE = r;
  if (r) {
    STACK.push(r);
  } else {
    STACK.length = 0;
  }
}

/**
 * Get the current active router.
 */
export function getActiveRouter(): ActiveRouter {
  if (!ACTIVE) {
    throw new Error(
      "@shadow-js/router: no active router. " +
        "Mount <Router ...> before using router hooks."
    );
  }
  return ACTIVE;
}
