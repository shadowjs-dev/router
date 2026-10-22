import { percentDecodeLenient } from "./encoding";
import { isSafeNavigationTarget, normalizeNavigationText } from "./url-safety";

/**
 * History with an owned, monotonic index, blockers and batched writes.
 *
 * Every entry this history writes carries its index in `history.state` (`__shadowIndex`), so a
 * popstate can be turned into a signed delta even when the browser reports no delta. Logical
 * state (the location the app sees) changes synchronously; physical writes to the platform are
 * queued and applied in one microtask, or at the next `flush()`, whichever comes first.
 *
 * Back and forward that a blocker vetoes are reverted with `go(-delta)`. The revert's own
 * popstate lands on the logical index and is ignored, so several fast traversals while a prompt
 * is open cannot desynchronize the index.
 */

/**
 * What caused a location change.
 * @since 1.0.0
 */
export type HistoryAction = "PUSH" | "REPLACE" | "POP";

/**
 * A location as the app sees it.
 * @since 1.0.0
 */
export interface HistoryLocation {
  readonly pathname: string;
  /** `""` or `?query`. */
  readonly search: string;
  /** `""` or `#fragment`. */
  readonly hash: string;
  readonly state: unknown;
  /** Owned index: 0 for the first entry, +1 per push. */
  readonly index: number;
}

/**
 * Notification sent to listeners after a committed change.
 * @since 1.0.0
 */
export interface HistoryUpdate {
  readonly action: HistoryAction;
  readonly location: HistoryLocation;
}

/**
 * A change that a blocker is considering.
 * @since 1.0.0
 */
export interface Transition {
  readonly action: HistoryAction;
  /** The location the change would produce. */
  readonly location: HistoryLocation;
  /** Index difference for POP, undefined otherwise. */
  readonly delta: number | undefined;
  /** Performs the change now, bypassing blockers once. No effect once superseded. */
  proceed(): void;
  /** Drops the change. For POP the location was already reverted, so nothing else happens. */
  cancel(): void;
}

/**
 * Called for every change while registered. Calling `proceed()` lets the change through.
 * @since 1.0.0
 */
export type Blocker = (transition: Transition) => void;

/**
 * A history over one location stack.
 * @since 1.0.0
 */
export interface History {
  readonly location: HistoryLocation;
  /** The change a blocker is holding, if any. */
  readonly pending: Transition | undefined;
  /** Number of entries in the stack. */
  readonly length: number;
  /**
   * Pushes an entry. Same URL with the same state is a no-op; same URL with new state replaces.
   * @returns true when the change was applied now, false when a blocker is holding it.
   * @throws TypeError for a target that fails the navigation-target check.
   */
  push(to: string, state?: unknown): boolean;
  /** Replaces the current entry. Same rules as {@link History.push}. */
  replace(to: string, state?: unknown): boolean;
  /** Traverses by `delta` entries. Zero does nothing. */
  go(delta: number): void;
  back(): void;
  forward(): void;
  /** Registers a listener for committed changes. Returns the unsubscribe function. */
  listen(listener: (update: HistoryUpdate) => void): () => void;
  /** Registers a blocker. Returns the function that removes it. */
  block(blocker: Blocker): () => void;
  /** Applies queued physical writes now. */
  flush(): void;
  /** Removes platform listeners and drops blockers and queued writes. */
  destroy(): void;
}

/**
 * A browser-backed history.
 * @since 1.0.0
 */
export interface BrowserHistory extends History {
  /**
   * While `shouldBlock()` returns true, the page's unload is prevented (for example to warn about
   * unsaved work). Only document-leaving unloads are affected, never in-app navigation.
   * @returns Removes the guard.
   */
  guardUnload(shouldBlock: () => boolean): () => void;
}

/**
 * The event object a window listener receives.
 * @since 1.0.0
 */
export interface WindowEventLike {
  preventDefault(): void;
  returnValue: unknown;
}

/**
 * The part of `window` a browser history needs. Tests supply a fake.
 * @since 1.0.0
 */
export interface WindowLike {
  readonly location: { readonly pathname: string; readonly search: string; readonly hash: string };
  readonly history: {
    readonly state: unknown;
    readonly length: number;
    pushState(state: unknown, title: string, url: string): void;
    replaceState(state: unknown, title: string, url: string): void;
    go(delta: number): void;
  };
  addEventListener(
    type: "popstate" | "beforeunload",
    listener: (event: WindowEventLike) => void,
  ): void;
  removeEventListener(
    type: "popstate" | "beforeunload",
    listener: (event: WindowEventLike) => void,
  ): void;
}

/**
 * Options shared by the three history factories.
 * @since 1.0.0
 */
export interface HistoryOptions {
  /** Schedules the physical-write flush. Defaults to a microtask. */
  readonly scheduleFlush?: (run: () => void) => void;
}

/**
 * Options for {@link createMemoryHistory}.
 * @since 1.0.0
 */
export interface MemoryHistoryOptions extends HistoryOptions {
  /** Starting stack, as paths. Defaults to `["/"]`. */
  readonly initialEntries?: readonly string[];
  /** Index of the starting entry. Defaults to the last one. */
  readonly initialIndex?: number;
}

const INDEX_KEY = "__shadowIndex";
const STATE_KEY = "__shadowState";

interface RawLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

interface WriteOperation {
  readonly replace: boolean;
  readonly index: number;
  readonly location: RawLocation;
  readonly raw: unknown;
}

/** The platform the core drives: memory, browser or hash. */
interface Platform {
  readLocation(): RawLocation;
  readRawState(): unknown;
  write(operation: WriteOperation): void;
  /** Traverses. Browsers may report the result later through `attach`'s handler. */
  go(delta: number): void;
  attach(onPop: () => void): () => void;
  size(): number;
}

interface Stamp {
  readonly index: number;
  readonly state: unknown;
}

function stampOf(index: number, state: unknown): Record<string, unknown> {
  return { [INDEX_KEY]: index, [STATE_KEY]: state };
}

function readStamp(raw: unknown): Stamp | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const index = record[INDEX_KEY];
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return undefined;
  return { index, state: record[STATE_KEY] };
}

function hrefOf(location: RawLocation): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

/** Removes dot segments, keeping a trailing slash when the input had one. */
function normalizeDots(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1];
  const out: string[] = [];
  for (const segment of segments.slice(1)) {
    if (segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  let result = `/${out.join("/")}`;
  const keepsTrailingSlash = last === "." || last === ".." || last === "";
  if (keepsTrailingSlash && !result.endsWith("/")) result += "/";
  return result;
}

interface TargetParts {
  readonly path: string;
  /** `undefined` when the target has no `?`. */
  readonly query: string | undefined;
  readonly hash: string;
}

function splitTarget(text: string): TargetParts {
  const hashAt = text.indexOf("#");
  const hash = hashAt < 0 ? "" : text.slice(hashAt);
  const beforeHash = hashAt < 0 ? text : text.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const query = queryAt < 0 ? undefined : beforeHash.slice(queryAt);
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  return { path, query, hash: hash === "#" ? "" : hash };
}

function normalizeQuery(query: string | undefined): string {
  return query === undefined || query === "?" ? "" : query;
}

/**
 * Resolves a navigation target against the current location. A query-only target keeps the
 * current pathname; a hash-only target keeps the query; relative paths resolve against the current
 * directory.
 *
 * @throws TypeError for a target that fails the scheme check.
 * @example
 * import { resolveLocation } from "@shadow-js/router/core";
 * resolveLocation({ pathname: "/posts/7", search: "?page=2" }, "edit"); // { pathname: "/posts/edit", search: "", hash: "" }
 * resolveLocation({ pathname: "/posts/7", search: "?page=2" }, "?tab=b"); // { pathname: "/posts/7", search: "?tab=b", hash: "" }
 * @since 1.0.0
 */
export function resolveLocation(
  current: { readonly pathname: string; readonly search: string },
  to: string,
): { readonly pathname: string; readonly search: string; readonly hash: string } {
  const text = normalizeNavigationText(to);
  if (text === undefined || !isSafeNavigationTarget(text)) {
    throw new TypeError(
      __DEV__ ? `unsafe navigation target: ${JSON.stringify(to)}` : "SHADOW_UNSAFE_TARGET",
    );
  }
  const parts = splitTarget(text);
  if (parts.path === "") {
    return {
      pathname: current.pathname,
      search: parts.query === undefined ? current.search : normalizeQuery(parts.query),
      hash: parts.hash,
    };
  }
  const pathname = parts.path.startsWith("/")
    ? normalizeDots(parts.path)
    : normalizeDots(
        `${current.pathname.slice(0, current.pathname.lastIndexOf("/") + 1)}${parts.path}`,
      );
  return { pathname, search: normalizeQuery(parts.query), hash: parts.hash };
}

/** Parses a path-like string (a hash route or an initial entry) without relative resolution. */
function parseAbsolute(text: string): RawLocation {
  const parts = splitTarget(text);
  const path = parts.path === "" ? "/" : parts.path;
  return {
    pathname: path.startsWith("/") ? path : `/${path}`,
    search: normalizeQuery(parts.query),
    hash: parts.hash,
  };
}

/**
 * Decodes a hash for scrolling or lookups. Never throws: malformed escapes stay literal.
 *
 * @param hash `#fragment` or `fragment`.
 * @returns The decoded fragment without `#`.
 * @example decodeHash("#%") // "%"
 * @since 1.0.0
 */
export function decodeHash(hash: string): string {
  return percentDecodeLenient(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** The core: logical state, blockers, batching and the POP algorithm. */
function createCore(platform: Platform, options: HistoryOptions): History {
  const scheduleFlush = options.scheduleFlush ?? ((run: () => void): void => queueMicrotask(run));
  const listeners = new Set<(update: HistoryUpdate) => void>();
  const blockers: Blocker[] = [];
  let destroyed = false;
  let flushScheduled = false;
  let queue: WriteOperation[] = [];
  let pending: Transition | undefined;
  let bypassIndex: number | undefined;

  const initialStamp = readStamp(platform.readRawState());
  let index = 0;
  let state: unknown;
  if (initialStamp === undefined) {
    platform.write({
      replace: true,
      index: 0,
      location: platform.readLocation(),
      raw: stampOf(0, undefined),
    });
  } else {
    index = initialStamp.index;
    state = initialStamp.state;
  }
  const start = platform.readLocation();
  let current: HistoryLocation = {
    pathname: start.pathname,
    search: start.search,
    hash: start.hash,
    state,
    index,
  };

  function flush(): void {
    flushScheduled = false;
    const operations = queue;
    queue = [];
    for (const operation of operations) platform.write(operation);
  }

  function enqueue(operation: WriteOperation): void {
    const last = queue[queue.length - 1];
    if (operation.replace && last !== undefined) {
      // A replace that follows a queued write changes that write's target: push + replace = push.
      queue[queue.length - 1] = { ...last, location: operation.location, raw: operation.raw };
    } else {
      queue.push(operation);
    }
    if (!flushScheduled) {
      flushScheduled = true;
      scheduleFlush(flush);
    }
  }

  function notify(action: HistoryAction, location: HistoryLocation): void {
    const update: HistoryUpdate = { action, location };
    let failure: { readonly error: unknown } | undefined;
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch (error) {
        // Every listener runs; the first failure is rethrown afterward.
        if (failure === undefined) failure = { error };
      }
    }
    if (failure !== undefined) throw failure.error;
  }

  function commitWrite(action: "PUSH" | "REPLACE", location: RawLocation, data: unknown): void {
    if (action === "PUSH") {
      const next: HistoryLocation = {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        state: data,
        index: current.index + 1,
      };
      current = next;
      enqueue({ replace: false, index: next.index, location, raw: stampOf(next.index, data) });
    } else {
      const next: HistoryLocation = {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        state: data,
        index: current.index,
      };
      current = next;
      enqueue({ replace: true, index: next.index, location, raw: stampOf(next.index, data) });
    }
    notify(action, current);
  }

  function makeTransition(
    action: HistoryAction,
    location: HistoryLocation,
    delta: number | undefined,
  ): Transition {
    const transition: Transition = {
      action,
      location,
      delta,
      proceed(): void {
        if (pending !== transition) return;
        pending = undefined;
        perform(transition);
      },
      cancel(): void {
        if (pending === transition) pending = undefined;
      },
    };
    return transition;
  }

  function perform(transition: Transition): void {
    if (transition.action === "POP") {
      // The location was reverted when the POP was blocked, so `delta` is relative to the logical
      // position. The target index identifies the popstate that should be let through.
      bypassIndex = current.index + (transition.delta ?? 0);
      platform.go(transition.delta ?? 0);
      return;
    }
    commitWrite(transition.action, transition.location, transition.location.state);
  }

  /** Offers a transition to the blockers. Returns true when one of them let it through. */
  function offer(transition: Transition): boolean {
    pending = transition;
    for (const blocker of [...blockers]) {
      blocker(transition);
      if (pending !== transition) return true;
    }
    return false;
  }

  function commitPop(location: RawLocation, data: unknown, target: number): void {
    current = {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      state: data,
      index: target,
    };
    notify("POP", current);
  }

  function onPop(): void {
    if (destroyed) return;
    flush();
    const location = platform.readLocation();
    const stamp = readStamp(platform.readRawState());
    if (stamp === undefined) {
      // An entry this history did not write. Adopt it at the logical index; blockers are not asked.
      platform.write({
        replace: true,
        index: current.index,
        location,
        raw: stampOf(current.index, undefined),
      });
      commitPop(location, undefined, current.index);
      return;
    }
    if (bypassIndex !== undefined && stamp.index === bypassIndex) {
      bypassIndex = undefined;
      commitPop(location, stamp.state, stamp.index);
      return;
    }
    if (stamp.index === current.index) return;
    const delta = stamp.index - current.index;
    if (blockers.length === 0) {
      commitPop(location, stamp.state, stamp.index);
      return;
    }
    // Revert first: the browser already moved, and the logical location must stay put while a
    // blocker decides. The revert's popstate lands on current.index and is ignored above.
    platform.go(-delta);
    const next: HistoryLocation = {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      state: stamp.state,
      index: stamp.index,
    };
    offer(makeTransition("POP", next, delta));
  }

  function navigate(action: "PUSH" | "REPLACE", to: string, data: unknown): boolean {
    if (destroyed) return false;
    const target = resolveLocation(current, to);
    const sameHref =
      target.pathname === current.pathname &&
      target.search === current.search &&
      target.hash === current.hash;
    let effective: "PUSH" | "REPLACE" = action;
    if (sameHref) {
      if (Object.is(data, current.state)) return true;
      effective = "REPLACE";
    }
    pending = undefined;
    const location: HistoryLocation = {
      pathname: target.pathname,
      search: target.search,
      hash: target.hash,
      state: data,
      index: current.index,
    };
    const transition = makeTransition(effective, location, undefined);
    if (blockers.length === 0) {
      perform(transition);
      return true;
    }
    return offer(transition);
  }

  function goBy(delta: number): void {
    if (destroyed || delta === 0) return;
    flush();
    platform.go(delta);
  }

  const detach = platform.attach(onPop);

  return {
    get location(): HistoryLocation {
      return current;
    },
    get pending(): Transition | undefined {
      return pending;
    },
    get length(): number {
      return platform.size();
    },
    push(to: string, data?: unknown): boolean {
      return navigate("PUSH", to, data);
    },
    replace(to: string, data?: unknown): boolean {
      return navigate("REPLACE", to, data);
    },
    go: goBy,
    back(): void {
      goBy(-1);
    },
    forward(): void {
      goBy(1);
    },
    listen(listener: (update: HistoryUpdate) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    block(blocker: Blocker): () => void {
      blockers.push(blocker);
      return (): void => {
        const at = blockers.indexOf(blocker);
        if (at >= 0) blockers.splice(at, 1);
      };
    },
    flush,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      detach();
      listeners.clear();
      blockers.length = 0;
      pending = undefined;
      queue = [];
    },
  };
}

/**
 * An in-memory history for tests, servers and non-browser hosts.
 *
 * @param options Initial stack, index and flush scheduler.
 * @returns A history whose stack lives in this object.
 * @example
 * const history = createMemoryHistory({ initialEntries: ["/", "/about"] });
 * history.push("/posts/1");
 * history.back();
 * @since 1.0.0
 */
export function createMemoryHistory(options: MemoryHistoryOptions = {}): History {
  const paths = options.initialEntries ?? ["/"];
  const entries: { location: RawLocation; raw: unknown }[] = paths.map((path, position) => ({
    location: parseAbsolute(path),
    raw: stampOf(position, undefined),
  }));
  let position = options.initialIndex ?? entries.length - 1;
  if (position < 0 || position >= entries.length) {
    throw new RangeError(
      __DEV__
        ? `initialIndex ${position} is outside the ${entries.length} entries`
        : "SHADOW_INITIAL_INDEX",
    );
  }
  const handlers = new Set<() => void>();
  const fallback: RawLocation = { pathname: "/", search: "", hash: "" };

  const platform: Platform = {
    readLocation(): RawLocation {
      return entries[position]?.location ?? fallback;
    },
    readRawState(): unknown {
      return entries[position]?.raw;
    },
    write(operation: WriteOperation): void {
      const entry = { location: operation.location, raw: operation.raw };
      if (operation.replace) {
        if (operation.index < entries.length) entries[operation.index] = entry;
      } else {
        entries.splice(operation.index, entries.length - operation.index, entry);
      }
      position = operation.index;
    },
    go(delta: number): void {
      const next = position + delta;
      if (next < 0 || next >= entries.length) return;
      position = next;
      for (const handler of [...handlers]) handler();
    },
    attach(onPop: () => void): () => void {
      handlers.add(onPop);
      return (): void => {
        handlers.delete(onPop);
      };
    },
    size(): number {
      return entries.length;
    },
  };
  return createCore(platform, options);
}

function browserLocation(win: WindowLike): RawLocation {
  const location = win.location;
  return {
    pathname: location.pathname === "" ? "/" : location.pathname,
    search: normalizeQuery(location.search),
    hash: location.hash === "#" ? "" : location.hash,
  };
}

function platformForBrowser(win: WindowLike, hashMode: boolean): Platform {
  return {
    readLocation(): RawLocation {
      if (!hashMode) return browserLocation(win);
      const text = win.location.hash.startsWith("#")
        ? win.location.hash.slice(1)
        : win.location.hash;
      return parseAbsolute(text);
    },
    readRawState(): unknown {
      return win.history.state;
    },
    write(operation: WriteOperation): void {
      const url = hashMode ? `#${hrefOf(operation.location)}` : hrefOf(operation.location);
      if (operation.replace) {
        win.history.replaceState(operation.raw, "", url);
      } else {
        win.history.pushState(operation.raw, "", url);
      }
    },
    go(delta: number): void {
      win.history.go(delta);
    },
    attach(onPop: () => void): () => void {
      const listener = (): void => {
        onPop();
      };
      win.addEventListener("popstate", listener);
      return (): void => {
        win.removeEventListener("popstate", listener);
      };
    },
    size(): number {
      return win.history.length;
    },
  };
}

/**
 * Adds an unload guard to a browser history. The object is extended in place rather than copied,
 * so the live getters of the history keep working. `destroy()` also removes every guard.
 */
function withUnloadGuard(core: History, win: WindowLike): BrowserHistory {
  const releases = new Set<() => void>();
  const destroyCore = core.destroy;
  return Object.assign(core, {
    guardUnload(shouldBlock: () => boolean): () => void {
      const listener = (event: WindowEventLike): void => {
        if (shouldBlock()) {
          event.preventDefault();
          event.returnValue = "";
        }
      };
      win.addEventListener("beforeunload", listener);
      const release = (): void => {
        win.removeEventListener("beforeunload", listener);
        releases.delete(release);
      };
      releases.add(release);
      return release;
    },
    destroy(): void {
      for (const release of [...releases]) release();
      destroyCore();
    },
  });
}

/**
 * A history over `window.history` with paths (`/a/b`).
 *
 * @param win Window-like object; tests pass a fake.
 * @param options Flush scheduler.
 * @returns A browser history. Call `destroy()` to remove the popstate listener.
 * @example
 * import { createBrowserHistory } from "@shadow-js/router/core";
 * const history = createBrowserHistory(window);
 * history.push("/posts/7");
 * history.destroy(); // removes the popstate listener
 * @since 1.0.0
 */
export function createBrowserHistory(
  win: WindowLike,
  options: HistoryOptions = {},
): BrowserHistory {
  return withUnloadGuard(createCore(platformForBrowser(win, false), options), win);
}

/**
 * A history over the URL fragment (`#/a/b`), for hosts that cannot change the path.
 *
 * @param win Window-like object; tests pass a fake.
 * @param options Flush scheduler.
 * @returns A hash history.
 * @example
 * import { createHashHistory } from "@shadow-js/router/core";
 * const history = createHashHistory(window);
 * history.push("/posts/7"); // the URL fragment becomes "#/posts/7"
 * @since 1.0.0
 */
export function createHashHistory(win: WindowLike, options: HistoryOptions = {}): BrowserHistory {
  return withUnloadGuard(createCore(platformForBrowser(win, true), options), win);
}
