import { canonicalKey } from "./canonical";
import { SieveCache } from "./sieve";

/**
 * Loader data cache: keyed by route id, params and loader deps; shared in-flight loads with
 * reference counting; stale-while-revalidate; bounded by entry count.
 *
 * Time and timers are injected, so the cache is deterministic under test. Every entry is bounded
 * by `maxEntries`, and the number of timers is at most one (the GC sweep), whatever the number of
 * entries.
 */

/**
 * Why a load is happening.
 * @since 1.0.0
 */
export type LoadIntent = "navigate" | "preload" | "hydrate" | "reload";

/**
 * A load request from the navigator.
 * @since 1.0.0
 */
export interface LoadRequest<T> {
  readonly routeId: string;
  readonly params: Readonly<Record<string, string>>;
  /** Loader deps. Part of the key; must be plain data. */
  readonly deps?: unknown;
  readonly tags?: readonly string[];
  readonly intent: LoadIntent;
  /** What a stale navigation does: show the stale value and refresh (default) or wait. */
  readonly staleReload?: "background" | "blocking";
  /** The consumer's signal. Aborting it releases this consumer's share of the flight. */
  readonly signal?: AbortSignal;
  /** The loader. It receives the flight's signal, which aborts when every consumer has left. */
  readonly run: (signal: AbortSignal) => Promise<T> | T;
}

/**
 * A cached value as seen by {@link LoaderCache.peek}.
 * @since 1.0.0
 */
export interface CacheEntryView {
  readonly value: unknown;
  readonly updatedAt: number;
  /** True when the next navigation would refresh it. */
  readonly stale: boolean;
}

/**
 * Which entries to invalidate. Each given field must match exactly. No fields means all.
 * @since 1.0.0
 */
export interface InvalidateFilter {
  readonly routeId?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly tag?: string;
}

/**
 * Options for {@link createLoaderCache}.
 * @since 1.0.0
 */
export interface LoaderCacheOptions {
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  /** Creates the abort controller of each flight. Defaults to the global `AbortController`. */
  readonly createAbortController?: () => AbortController;
  /** Hard cap on cached entries and on shared flights. Default 200. */
  readonly maxEntries?: number;
  /** Age after which a navigation treats an entry as stale. Default 0. */
  readonly staleTime?: number;
  /** Age after which a preload refetches. Default 30 000 ms. */
  readonly preloadStaleTime?: number;
  /** Idle time after which an entry is removed. Default 300 000 ms. */
  readonly gcTime?: number;
  /** Receives errors of background revalidations, which no consumer awaits. */
  readonly onError?: (error: unknown, routeId: string) => void;
}

/**
 * A loader data cache.
 * @since 1.0.0
 */
export interface LoaderCache {
  /**
   * Returns the data for a request: cached when fresh, the stale value while a background refresh
   * runs, or the result of a shared in-flight load.
   * @throws Rejects with an AbortError when the consumer's signal aborts or the cache is cleared.
   */
  load<T>(request: LoadRequest<T>): Promise<T>;
  /** Stores data without running a loader (used when the server rendered it). */
  seed(entry: {
    readonly routeId: string;
    readonly params: Readonly<Record<string, string>>;
    readonly deps?: unknown;
    readonly tags?: readonly string[];
    readonly value: unknown;
    readonly updatedAt?: number;
  }): void;
  /** Reads an entry without changing its recency. */
  peek(
    routeId: string,
    params: Readonly<Record<string, string>>,
    deps?: unknown,
  ): CacheEntryView | undefined;
  /** Marks matching entries stale. Their data stays available for background refresh. */
  invalidate(filter: InvalidateFilter): void;
  /** Removes every entry and aborts every in-flight load. */
  clearAll(): void;
  /** Stops the GC timer and rejects further loads. */
  destroy(): void;
  /** Number of cached entries. Never above `maxEntries`. */
  readonly size: number;
  /** Number of shared in-flight loads. */
  readonly inFlight: number;
}

interface Entry {
  readonly routeId: string;
  readonly paramsKey: string;
  readonly tags: readonly string[];
  value: unknown;
  updatedAt: number;
  invalidated: boolean;
  lastUsed: number;
}

interface Flight {
  readonly controller: AbortController;
  /** Consumers still waiting on this flight. */
  refs: number;
  canceled: boolean;
  settled: boolean;
  readonly promise: Promise<unknown>;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_PRELOAD_STALE_TIME = 30_000;
const DEFAULT_GC_TIME = 300_000;

function abortError(): Error {
  const error = new Error("the load was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Creates a loader cache.
 *
 * @param options Clock, timers, limits and freshness times.
 * @returns A cache owned by one router instance.
 * @example
 * const cache = createLoaderCache({ now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
 * @since 1.0.0
 */
export function createLoaderCache(options: LoaderCacheOptions): LoaderCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const staleTime = options.staleTime ?? 0;
  const preloadStaleTime = options.preloadStaleTime ?? DEFAULT_PRELOAD_STALE_TIME;
  const gcTime = options.gcTime ?? DEFAULT_GC_TIME;
  const newController =
    options.createAbortController ?? ((): AbortController => new AbortController());
  const entries = new SieveCache<string, Entry>(maxEntries);
  const flights = new Map<string, Flight>();
  let gcTimer: { readonly handle: unknown } | undefined;
  let destroyed = false;

  function keyOf(
    routeId: string,
    params: Readonly<Record<string, string>>,
    deps: unknown,
  ): { readonly key: string; readonly paramsKey: string } {
    return {
      key: canonicalKey([routeId, params, deps]),
      paramsKey: canonicalKey(params),
    };
  }

  function sweep(): void {
    gcTimer = undefined;
    const now = options.now();
    for (const [key, entry] of entries.entries()) {
      if (now - entry.lastUsed >= gcTime) entries.delete(key);
    }
    scheduleGc();
  }

  function scheduleGc(): void {
    if (gcTimer !== undefined || entries.size === 0 || destroyed) return;
    gcTimer = { handle: options.setTimeout(sweep, gcTime) };
  }

  function clearGc(): void {
    if (gcTimer === undefined) return;
    options.clearTimeout(gcTimer.handle);
    gcTimer = undefined;
  }

  function store(
    key: string,
    paramsKey: string,
    routeId: string,
    tags: readonly string[],
    value: unknown,
    updatedAt: number,
  ): void {
    entries.set(key, {
      routeId,
      paramsKey,
      tags,
      value,
      updatedAt,
      invalidated: false,
      lastUsed: updatedAt,
    });
    scheduleGc();
  }

  function forget(key: string, flight: Flight): void {
    flight.settled = true;
    if (flights.get(key) === flight) flights.delete(key);
  }

  function startFlight<T>(
    key: string,
    paramsKey: string,
    request: LoadRequest<T>,
    background: boolean,
  ): Flight {
    const controller = newController();
    const tags = request.tags ?? [];
    // An aborted flight never starts its loader: nobody is waiting for the data any more.
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError();
      return request.run(controller.signal);
    });
    const flight: Flight = {
      controller,
      refs: 0,
      canceled: false,
      settled: false,
      promise: work.then(
        (value: unknown) => {
          forget(key, flight);
          if (!flight.canceled && !controller.signal.aborted) {
            store(key, paramsKey, request.routeId, tags, value, options.now());
          }
          return value;
        },
        (error: unknown) => {
          forget(key, flight);
          throw error;
        },
      ),
    };
    if (background) {
      flight.promise.then(undefined, (error: unknown) => {
        if (options.onError !== undefined) options.onError(error, request.routeId);
      });
    }
    return flight;
  }

  /** Joins a flight as one consumer. Aborting the consumer's signal releases its share. */
  function join<T>(key: string, flight: Flight, signal: AbortSignal | undefined): Promise<T> {
    flight.refs += 1;
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const onAbort = (): void => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", onAbort);
        flight.refs -= 1;
        if (flight.refs === 0 && !flight.settled) {
          flight.canceled = true;
          flight.controller.abort();
          if (flights.get(key) === flight) flights.delete(key);
        }
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort);
      flight.promise.then(
        (value: unknown) => {
          if (released) return;
          signal?.removeEventListener("abort", onAbort);
          if (flight.canceled) {
            reject(abortError());
          } else {
            resolve(value as T);
          }
        },
        (error: unknown) => {
          if (released) return;
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  function flightFor<T>(
    key: string,
    paramsKey: string,
    request: LoadRequest<T>,
    background: boolean,
  ): Flight {
    const existing = flights.get(key);
    if (existing !== undefined) return existing;
    const flight = startFlight(key, paramsKey, request, background);
    // Beyond the cap a flight still runs, it is simply not shared, which bounds the table.
    if (flights.size < maxEntries) flights.set(key, flight);
    return flight;
  }

  function clearAll(): void {
    for (const flight of flights.values()) {
      flight.canceled = true;
      flight.controller.abort();
    }
    flights.clear();
    entries.clear();
    clearGc();
  }

  return {
    load<T>(request: LoadRequest<T>): Promise<T> {
      if (destroyed || request.signal?.aborted === true) {
        return Promise.reject(abortError());
      }
      let identity: { readonly key: string; readonly paramsKey: string };
      try {
        identity = keyOf(request.routeId, request.params, request.deps);
      } catch (error) {
        return Promise.reject(error);
      }
      const { key, paramsKey } = identity;
      const now = options.now();
      const existing = entries.get(key);
      if (existing !== undefined && request.intent !== "reload") {
        existing.lastUsed = now;
        const threshold = request.intent === "preload" ? preloadStaleTime : staleTime;
        const fresh =
          !existing.invalidated &&
          (request.intent === "hydrate" || now - existing.updatedAt < threshold);
        if (fresh) return Promise.resolve(existing.value as T);
        const backgroundRefresh =
          request.intent === "navigate" && request.staleReload !== "blocking";
        if (backgroundRefresh) {
          if (!flights.has(key)) flightFor(key, paramsKey, request, true);
          return Promise.resolve(existing.value as T);
        }
      }
      return join<T>(key, flightFor(key, paramsKey, request, false), request.signal);
    },

    seed(entry): void {
      if (destroyed) return;
      const { key, paramsKey } = keyOf(entry.routeId, entry.params, entry.deps);
      store(
        key,
        paramsKey,
        entry.routeId,
        entry.tags ?? [],
        entry.value,
        entry.updatedAt ?? options.now(),
      );
    },

    peek(routeId, params, deps): CacheEntryView | undefined {
      const { key } = keyOf(routeId, params, deps);
      const entry = entries.peek(key);
      if (entry === undefined) return undefined;
      return {
        value: entry.value,
        updatedAt: entry.updatedAt,
        stale: entry.invalidated || options.now() - entry.updatedAt >= staleTime,
      };
    },

    invalidate(filter: InvalidateFilter): void {
      const paramsKey = filter.params === undefined ? undefined : canonicalKey(filter.params);
      for (const [, entry] of entries.entries()) {
        if (filter.routeId !== undefined && entry.routeId !== filter.routeId) continue;
        if (paramsKey !== undefined && entry.paramsKey !== paramsKey) continue;
        if (filter.tag !== undefined && !entry.tags.includes(filter.tag)) continue;
        entry.invalidated = true;
      }
    },

    clearAll,

    destroy(): void {
      if (destroyed) return;
      clearAll();
      destroyed = true;
    },

    get size(): number {
      return entries.size;
    },

    get inFlight(): number {
      return flights.size;
    },
  };
}
