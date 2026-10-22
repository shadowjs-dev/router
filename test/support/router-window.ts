import type { WindowEventLike } from "../../src/core/index";
import type { RouterWindow } from "../../src/types";
import { FakeWindow } from "./fake-window";

type Listener = (event: never) => void;

/** Storage that can be switched to throw, to test the guards. */
export class FakeStorage {
  readonly items: Map<string, string> = new Map<string, string>();
  failing: "none" | "read" | "write" | "both" = "none";

  getItem(key: string): string | null {
    if (this.failing === "read" || this.failing === "both") throw new Error("storage read denied");
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failing === "write" || this.failing === "both") throw new Error("quota exceeded");
    this.items.set(key, value);
  }
}

/**
 * A window for router tests: a fake history (from {@link FakeWindow}) plus every other member the
 * router touches. It counts listener registrations per event type, so a test can assert that a
 * disposed router removed everything it added. Scroll calls and view transitions are recorded.
 */
export class RouterTestWindow extends FakeWindow implements RouterWindow {
  readonly #others = new Map<string, Set<Listener>>();
  readonly added: string[] = [];
  readonly removed: string[] = [];
  scrollX = 0;
  scrollY = 0;
  readonly scrolls: Array<readonly [number, number]> = [];
  readonly sessionStorage: FakeStorage = new FakeStorage();
  readonly elements: Map<string, { scrollIntoView?(): void }> = new Map();
  /** One entry per started view transition. */
  readonly transitions: string[] = [];
  /** The `types` each transition started with (`undefined` when it was started without types). */
  readonly transitionTypes: Array<readonly string[] | undefined> = [];
  /** Times a started transition was skipped (`skipTransition`). */
  skipped = 0;
  reducedMotion = false;
  hasViewTransitions = false;
  /** Whether this window offers transition types (`ViewTransition.prototype.types`). */
  hasTransitionTypes = false;
  /** When true, a transition's `finished` settles only when the test calls `finishTransitions`. */
  holdTransitions = false;
  /** When true, a transition's update callback runs only when the test calls `runDeferredUpdates`. */
  deferUpdates = false;
  readonly #finishers: Array<() => void> = [];
  readonly #deferred: Array<() => void> = [];
  readonly document: {
    getElementById(id: string): { scrollIntoView?(): void } | null;
    readonly startViewTransition: NonNullable<RouterWindow["document"]>["startViewTransition"];
  };

  constructor(initialUrl: string = "/") {
    super(initialUrl);
    const owner = this;
    this.document = {
      getElementById: (id: string) => owner.elements.get(id) ?? null,
      get startViewTransition() {
        if (!owner.hasViewTransitions) return undefined;
        return (
          arg: (() => void) | { readonly update: () => void; readonly types?: string[] },
        ): unknown => {
          const update = typeof arg === "function" ? arg : arg.update;
          owner.transitions.push("start");
          owner.transitionTypes.push(typeof arg === "function" ? undefined : arg.types);
          if (owner.deferUpdates) owner.#deferred.push(update);
          else update();
          const finished = owner.holdTransitions
            ? new Promise<void>((resolve) => owner.#finishers.push(resolve))
            : Promise.resolve();
          return {
            finished,
            ready: finished,
            updateCallbackDone: Promise.resolve(),
            skipTransition: (): void => {
              owner.skipped += 1;
            },
          };
        };
      },
    };
  }

  /** The `ViewTransition` class, where types are supported. */
  get ViewTransition(): { readonly prototype: object } | undefined {
    return this.hasTransitionTypes ? { prototype: { types: new Set<string>() } } : undefined;
  }

  /** Settles the `finished` promise of every held transition. */
  finishTransitions(): void {
    for (const finish of this.#finishers.splice(0)) finish();
  }

  /** Runs the update callbacks that `deferUpdates` kept back, oldest first. */
  runDeferredUpdates(): void {
    for (const update of this.#deferred.splice(0)) update();
  }

  /** Records the scroll and moves the position. */
  scrollTo(x: number, y: number): void {
    this.scrollX = x;
    this.scrollY = y;
    this.scrolls.push([x, y]);
  }

  matchMedia(query: string): { readonly matches: boolean } {
    return { matches: this.reducedMotion && query.includes("reduce") };
  }

  override addEventListener(type: string, listener: (event: never) => void): void {
    if (type === "popstate" || type === "beforeunload") {
      super.addEventListener(type, listener as (event: WindowEventLike) => void);
    } else {
      let set = this.#others.get(type);
      if (set === undefined) {
        set = new Set();
        this.#others.set(type, set);
      }
      set.add(listener);
    }
    this.added.push(type);
  }

  override removeEventListener(type: string, listener: (event: never) => void): void {
    if (type === "popstate" || type === "beforeunload") {
      super.removeEventListener(type, listener as (event: WindowEventLike) => void);
    } else {
      this.#others.get(type)?.delete(listener);
    }
    this.removed.push(type);
  }

  /** Listeners registered now, across every event type. */
  get activeListeners(): number {
    let total = this.listenerCount("popstate") + this.listenerCount("beforeunload");
    for (const set of this.#others.values()) total += set.size;
    return total;
  }

  /** Listeners registered now for one event type. */
  countOf(type: string): number {
    if (type === "popstate" || type === "beforeunload") return this.listenerCount(type);
    return this.#others.get(type)?.size ?? 0;
  }

  /** Dispatches a non-history event to its listeners. */
  dispatch(type: string): void {
    for (const listener of [...(this.#others.get(type) ?? [])]) {
      (listener as (event: unknown) => void)(undefined);
    }
  }
}
