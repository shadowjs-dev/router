import type { WindowEventLike, WindowLike } from "../../src/core/history";

/**
 * A window-like object for history tests. Browser traversals are asynchronous, so `history.go`
 * only queues a traversal; a test decides when it runs (`runNextTraversal`, `runAllTraversals`).
 * A traversal past either end of the session history does nothing, as in browsers.
 */

interface FakeEntry {
  readonly url: string;
  readonly state: unknown;
}

type Listener = (event: WindowEventLike) => void;

interface FakeEvent extends WindowEventLike {
  defaultPrevented: boolean;
}

/** Splits a URL the way `window.location` reports it. */
function splitUrl(url: string): { pathname: string; search: string; hash: string } {
  if (url.startsWith("#")) {
    return { pathname: "/", search: "", hash: url === "#" ? "" : url };
  }
  const hashAt = url.indexOf("#");
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const search = queryAt < 0 ? "" : beforeHash.slice(queryAt);
  const pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  return { pathname: pathname === "" ? "/" : pathname, search: search === "?" ? "" : search, hash };
}

export class FakeWindow implements WindowLike {
  #entries: FakeEntry[];
  #position: number;
  readonly #queue: number[] = [];
  readonly #popstate = new Set<Listener>();
  readonly #beforeunload = new Set<Listener>();
  /** Every traversal that actually moved the position, in order. */
  readonly traversals: number[] = [];

  constructor(initialUrl: string = "/", initialState: unknown = null) {
    this.#entries = [{ url: initialUrl, state: initialState }];
    this.#position = 0;
  }

  get location(): { readonly pathname: string; readonly search: string; readonly hash: string } {
    const entry = this.#entries[this.#position];
    return splitUrl(entry?.url ?? "/");
  }

  get history(): FakeHistory {
    return new FakeHistory(this);
  }

  /** Current session-history position, for assertions. */
  get position(): number {
    return this.#position;
  }

  /** Number of session-history entries. */
  get entryCount(): number {
    return this.#entries.length;
  }

  /** URL of the entry at `index`. */
  urlAt(index: number): string | undefined {
    return this.#entries[index]?.url;
  }

  /** Traversals queued but not yet run. */
  get pendingTraversals(): number {
    return this.#queue.length;
  }

  addEventListener(type: "popstate" | "beforeunload", listener: Listener): void {
    this.#listenersFor(type).add(listener);
  }

  removeEventListener(type: "popstate" | "beforeunload", listener: Listener): void {
    this.#listenersFor(type).delete(listener);
  }

  /** Number of listeners registered for an event type. */
  listenerCount(type: "popstate" | "beforeunload"): number {
    return this.#listenersFor(type).size;
  }

  /** Runs the oldest queued traversal. Returns false when there was none. */
  runNextTraversal(): boolean {
    const delta = this.#queue.shift();
    if (delta === undefined) return false;
    this.#traverse(delta);
    return true;
  }

  /** Runs queued traversals until none remain. A bound stops runaway loops in tests. */
  runAllTraversals(limit: number = 10_000): number {
    let ran = 0;
    while (ran < limit && this.runNextTraversal()) ran += 1;
    return ran;
  }

  /** Dispatches `beforeunload`. Returns true when some listener prevented the unload. */
  dispatchBeforeUnload(): boolean {
    const event: FakeEvent = {
      defaultPrevented: false,
      returnValue: undefined,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    for (const listener of [...this.#beforeunload]) listener(event);
    return event.defaultPrevented;
  }

  /** Pushes or replaces an entry, as `history.pushState` / `replaceState` do. */
  writeEntry(replace: boolean, state: unknown, url: string): void {
    if (replace) {
      this.#entries[this.#position] = { url, state };
      return;
    }
    this.#entries = this.#entries.slice(0, this.#position + 1);
    this.#entries.push({ url, state });
    this.#position = this.#entries.length - 1;
  }

  /** Queues a traversal, as `history.go` does. */
  queueGo(delta: number): void {
    this.#queue.push(delta);
  }

  #traverse(delta: number): void {
    const target = this.#position + delta;
    if (target < 0 || target >= this.#entries.length) return;
    this.#position = target;
    this.traversals.push(delta);
    const event: FakeEvent = {
      defaultPrevented: false,
      returnValue: undefined,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    for (const listener of [...this.#popstate]) listener(event);
  }

  #listenersFor(type: "popstate" | "beforeunload"): Set<Listener> {
    return type === "popstate" ? this.#popstate : this.#beforeunload;
  }

  /** State of the current entry. */
  currentState(): unknown {
    return this.#entries[this.#position]?.state;
  }
}

/** The `history` object of a {@link FakeWindow}. */
export class FakeHistory {
  readonly #window: FakeWindow;

  constructor(window: FakeWindow) {
    this.#window = window;
  }

  get state(): unknown {
    return this.#window.currentState();
  }

  get length(): number {
    return this.#window.entryCount;
  }

  pushState(state: unknown, _title: string, url: string): void {
    this.#window.writeEntry(false, state, url);
  }

  replaceState(state: unknown, _title: string, url: string): void {
    this.#window.writeEntry(true, state, url);
  }

  go(delta: number): void {
    this.#window.queueGo(delta);
  }
}
