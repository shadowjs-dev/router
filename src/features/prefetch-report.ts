import type { History } from "../core/history";
import type { PrefetchStrategy } from "../types";

/**
 * Why a link was not prefetched: the browser asks to save data (`"data-saver"`), the connection is slow for a speculative
 * strategy (`"slow-network"`), the link leaves to the browser (`"leaves-site"`), or the target was prefetched recently
 * (`"fresh"`).
 * @since 1.0.0
 */
export type PrefetchSkipReason = "data-saver" | "slow-network" | "leaves-site" | "fresh";

/**
 * What a prefetch report records. `href` is the target without its hash, `strategy` the one that asked for the load, and
 * `at` the router clock in milliseconds.
 *
 * - `started`: the load began (after the idle moment and the queue).
 * - `loaded`: it finished; `ms` is how long it took.
 * - `canceled`: it was dropped before it finished, because the link left the page.
 * - `skipped`: the link did not ask, for `reason`.
 * - `used`: a navigation reached a prefetched target while it was still fresh; `ageMs` is the time since it loaded. A target
 *   is reported used once per prefetch.
 *
 * @example
 * ```ts
 * import { createPrefetchReport, type PrefetchEvent } from "@shadow-js/router/prefetch-report";
 *
 * const seen: PrefetchEvent[] = [];
 * export const report = createPrefetchReport({ onEvent: (event) => seen.push(event) });
 * ```
 * @since 1.0.0
 */
export type PrefetchEvent =
  | {
      readonly kind: "started" | "canceled";
      readonly href: string;
      readonly strategy: PrefetchStrategy;
      readonly at: number;
    }
  | {
      readonly kind: "loaded";
      readonly href: string;
      readonly strategy: PrefetchStrategy;
      readonly at: number;
      readonly ms: number;
    }
  | {
      readonly kind: "skipped";
      readonly href: string;
      readonly strategy: PrefetchStrategy;
      readonly at: number;
      readonly reason: PrefetchSkipReason;
    }
  | {
      readonly kind: "used";
      readonly href: string;
      readonly strategy: PrefetchStrategy;
      readonly at: number;
      readonly ageMs: number;
    };

/**
 * The counts of one strategy in a {@link PrefetchSummary}. `wasted` is the loads that finished and were never used;
 * `hitRate` is `used / loaded`, or `undefined` when nothing finished.
 * @since 1.0.0
 */
export interface PrefetchCounts {
  readonly started: number;
  readonly loaded: number;
  readonly canceled: number;
  readonly skipped: number;
  readonly used: number;
  readonly wasted: number;
  readonly hitRate: number | undefined;
}

/**
 * The events folded into counts per strategy and in total.
 * @since 1.0.0
 */
export interface PrefetchSummary {
  readonly intent: PrefetchCounts;
  readonly viewport: PrefetchCounts;
  readonly render: PrefetchCounts;
  readonly total: PrefetchCounts;
}

type Mutable = { -readonly [K in keyof PrefetchCounts]: PrefetchCounts[K] };

function blank(): Mutable {
  return { started: 0, loaded: 0, canceled: 0, skipped: 0, used: 0, wasted: 0, hitRate: undefined };
}

/** Finishes the derived fields of counts that were only added up. */
function settle(counts: Mutable): PrefetchCounts {
  counts.wasted = Math.max(counts.loaded - counts.used, 0);
  counts.hitRate = counts.loaded === 0 ? undefined : counts.used / counts.loaded;
  return counts;
}

/** The three counters of a strategy and the total, added to as events arrive. */
interface Tally {
  readonly intent: Mutable;
  readonly viewport: Mutable;
  readonly render: Mutable;
  readonly total: Mutable;
}

function tally(): Tally {
  return { intent: blank(), viewport: blank(), render: blank(), total: blank() };
}

function count(into: Tally, event: PrefetchEvent): void {
  const part =
    event.strategy === "intent"
      ? into.intent
      : event.strategy === "viewport"
        ? into.viewport
        : into.render;
  part[event.kind] += 1;
  into.total[event.kind] += 1;
}

function summarize(from: Tally): PrefetchSummary {
  const copy = (counts: Mutable): PrefetchCounts => settle({ ...counts });
  return {
    intent: copy(from.intent),
    viewport: copy(from.viewport),
    render: copy(from.render),
    total: copy(from.total),
  };
}

/**
 * Folds events into counts, per strategy and in total, to compare strategies: a strategy with many loads and a low hit
 * rate spends the user's data for nothing; one with a high hit rate is worth its cost.
 *
 * @param events Events from a report or from your own log.
 * @returns The counts. Every event has one of the three strategies, because a link with `"none"` never asks.
 * @example
 * ```ts
 * import { type PrefetchEvent, summarizePrefetch } from "@shadow-js/router/prefetch-report";
 *
 * const events: PrefetchEvent[] = [
 *   { kind: "started", href: "/a", strategy: "intent", at: 0 },
 *   { kind: "loaded", href: "/a", strategy: "intent", at: 12, ms: 12 },
 *   { kind: "used", href: "/a", strategy: "intent", at: 400, ageMs: 388 },
 * ];
 * console.log(summarizePrefetch(events).intent.hitRate); // 1
 * ```
 * @since 1.0.0
 */
export function summarizePrefetch(events: readonly PrefetchEvent[]): PrefetchSummary {
  const into = tally();
  for (const event of events) count(into, event);
  return summarize(into);
}

/**
 * What the `prefetch` feature talks to. {@link createPrefetchReport} makes one; the feature calls `attach` when it installs
 * and `event` for everything it decides.
 * @since 1.0.0
 */
export interface PrefetchReporter {
  /** Called once when the feature installs; returns what to call when the router is disposed. */
  attach(
    host: { readonly history: History; readonly clock: { now(): number } },
    freshFor: number,
  ): () => void;
  /** Called for each decision and outcome. */
  event(
    kind: PrefetchEvent["kind"],
    href: string,
    strategy: PrefetchStrategy,
    reason?: PrefetchSkipReason,
  ): void;
}

/** Options of {@link createPrefetchReport}. @since 1.0.0 */
export interface PrefetchReportOptions {
  /** Called with every event, as it happens. A callback that throws is reported as an uncaught error and prefetching goes on. */
  readonly onEvent?: (event: PrefetchEvent) => void;
  /** How many of the latest events {@link PrefetchReport.events} keeps. The counts in `summary()` never forget. Default 500. */
  readonly maxEvents?: number;
}

/**
 * A reporter for `prefetch({ report })` that counts what happened and keeps the latest events.
 * @since 1.0.0
 */
export interface PrefetchReport extends PrefetchReporter {
  /** The latest events, oldest first, at most `maxEvents`. */
  readonly events: readonly PrefetchEvent[];
  /** The counts of everything reported so far, per strategy and in total. */
  summary(): PrefetchSummary;
  /** Forgets the events and the counts. */
  clear(): void;
}

/** Remembered targets; the oldest is forgotten past this. */
const MAX_TRACKED = 500;

/**
 * Creates a report to pass to `prefetch({ report })`. It records when each load starts and finishes, the links that were
 * skipped and why, and the navigations that used a prefetched target, and it can fold them into a hit rate per strategy.
 *
 * @param options A live callback and the number of events to keep.
 * @returns The report: pass it to `prefetch`, read `summary()` and `events` whenever you like.
 * @throws RangeError when `maxEvents` is not a positive integer.
 * @example
 * ```ts
 * import { prefetch } from "@shadow-js/router/prefetch";
 * import { createPrefetchReport } from "@shadow-js/router/prefetch-report";
 *
 * export const report = createPrefetchReport();
 * export const feature = prefetch({ strategy: "viewport", report });
 * // Later, for example in a dev tool or a periodic beacon:
 * export const hitRate = (): number | undefined => report.summary().total.hitRate;
 * ```
 * @since 1.0.0
 */
export function createPrefetchReport(options: PrefetchReportOptions = {}): PrefetchReport {
  const maxEvents = options.maxEvents ?? 500;
  if (!Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError("createPrefetchReport: maxEvents must be a positive integer.");
  }
  let counts = tally();
  let events: PrefetchEvent[] = [];
  let now: () => number = () => 0;
  let freshFor = 0;
  const started = new Map<string, number>();
  const loaded = new Map<
    string,
    {
      readonly at: number;
      readonly until: number;
      readonly strategy: PrefetchStrategy;
      used: boolean;
    }
  >();

  const push = (event: PrefetchEvent): void => {
    count(counts, event);
    events.push(event);
    if (events.length > maxEvents) events = events.slice(events.length - maxEvents);
    try {
      options.onEvent?.(event);
    } catch (error) {
      // A reporter must not break the feature it watches, and must not hide its own bug either.
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.delete(key);
    if (map.size >= MAX_TRACKED) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(key, value);
  };

  return {
    get events(): readonly PrefetchEvent[] {
      return events;
    },
    attach(host, fresh): () => void {
      now = () => host.clock.now();
      freshFor = fresh;
      return host.history.listen(({ location }) => {
        const href = `${location.pathname}${location.search}`;
        const entry = loaded.get(href);
        const at = now();
        if (entry === undefined || entry.used || entry.until <= at) return;
        entry.used = true;
        push({ kind: "used", href, strategy: entry.strategy, at, ageMs: at - entry.at });
      });
    },
    event(kind, href, strategy, reason): void {
      const at = now();
      if (kind === "started") {
        remember(started, href, at);
        push({ kind, href, strategy, at });
      } else if (kind === "loaded") {
        const began = started.get(href) ?? at;
        started.delete(href);
        remember(loaded, href, { at, until: at + freshFor, strategy, used: false });
        push({ kind, href, strategy, at, ms: at - began });
      } else if (kind === "skipped") {
        push({ kind, href, strategy, at, reason: reason ?? "fresh" });
      } else if (kind === "canceled") {
        started.delete(href);
        push({ kind, href, strategy, at });
      }
    },
    summary: () => summarize(counts),
    clear(): void {
      counts = tally();
      events = [];
      started.clear();
      loaded.clear();
    },
  };
}
