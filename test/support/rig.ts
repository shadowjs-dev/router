import {
  createMemoryHistory,
  createRouter,
  type RouteDefinition,
  type Router,
  type RouterOptions,
} from "../../src/index";
import { createFakeClock, type FakeClock } from "./fake-clock";
import { everyFeature } from "./features";
import { RouterTestWindow } from "./router-window";

/**
 * A router under test with its clock, window and error sink. Errors that the router reports in the
 * background land in `errors` instead of being thrown later, so each test can assert on them.
 */
export interface Rig {
  readonly router: Router;
  readonly clock: FakeClock;
  readonly win: RouterTestWindow;
  readonly errors: unknown[];
}

/** Options of {@link rig}: the router options a test may vary, except the ones the rig owns. */
export type RigOptions = Omit<RouterOptions, "routes" | "clock" | "window" | "onError">;

/** Builds a router with a fake clock and a fake window (browser history on the window). */
export function rig(
  routes: readonly RouteDefinition[],
  options: RigOptions & {
    readonly url?: string;
    readonly memory?: boolean;
    /** Runs on the window before the router is created (seed storage, make it fail). */
    readonly prepare?: (win: RouterTestWindow) => void;
  } = {},
): Rig {
  const { url = "/", memory = false, prepare, ...rest } = options;
  const clock = createFakeClock(0);
  const win = new RouterTestWindow(url);
  prepare?.(win);
  const errors: unknown[] = [];
  const router = createRouter({
    features: everyFeature(),
    ...rest,
    routes,
    clock,
    window: win,
    onError: (error: unknown) => {
      errors.push(error);
    },
    ...(memory ? { history: createMemoryHistory({ initialEntries: [url] }) } : {}),
  });
  return { router, clock, win, errors };
}

/** Lets pending promise continuations run (the router resolves in microtasks). */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < 80; tick += 1) await Promise.resolve();
}
