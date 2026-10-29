import type { PrefetchCapability, PrefetchLink, PrefetchTarget } from "../internal/capabilities";
import type { RouterCore } from "../internal/core";
import { createPrefetchQueue, type PrefetchTicket } from "../internal/prefetch-queue";
import type { HrefOf, PrefetchStrategy, RouterFeature } from "../types";
import type { PrefetchReporter, PrefetchSkipReason } from "./prefetch-report";

/**
 * Options of {@link prefetch}.
 * @since 1.0.0
 */
export interface PrefetchOptions {
  /** The strategy of a link that does not set `preload`. Default `"intent"`. */
  readonly strategy?: PrefetchStrategy;
  /** Milliseconds a pointer rests on a link before `"intent"` loads it. Default 50. */
  readonly intentDelay?: number;
  /** Milliseconds a link stays visible before `"viewport"` loads it. Default 100. */
  readonly viewportDelay?: number;
  /** The most loads in flight at once; the rest wait in order. Default 3. */
  readonly concurrency?: number;
  /** The longest a speculative load (`"viewport"`, `"render"`) waits for an idle moment, in milliseconds. Default 2000. */
  readonly idleTimeout?: number;
  /**
   * Milliseconds a target counts as already loaded after a prefetch, so scrolling a link in and out of view does not
   * load it again. Match the loader cache's `preloadStaleTime`. Default 30 000.
   */
  readonly freshFor?: number;
  /**
   * Receives what the feature decides and what comes of it (a load started, finished or canceled, a link skipped and why, a
   * navigation that used a prefetched target), to find out which strategy pays off. Make one with `createPrefetchReport()` from
   * `@shadow-js/router/prefetch-report`; a feature without a reporter pays for none of it.
   */
  readonly report?: PrefetchReporter;
}

/** The `navigator.connection` fields this feature reads. */
interface Connection {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/** The longest an intent load waits for an idle moment: the user already asked for it. */
const INTENT_IDLE_MS = 100;
/** How long to wait where `requestIdleCallback` does not exist. */
const IDLE_FALLBACK_MS = 1;
/** Remembered targets; the oldest is forgotten past this. */
const MAX_REMEMBERED = 500;

type IdleGlobal = {
  requestIdleCallback?: (run: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** Runs `run` when the browser is idle (or soon, without `requestIdleCallback`). Returns the canceler. */
function whenIdle(run: () => void, timeout: number): () => void {
  const scope = globalThis as IdleGlobal;
  if (typeof scope.requestIdleCallback === "function") {
    const handle = scope.requestIdleCallback(run, { timeout });
    return (): void => scope.cancelIdleCallback?.(handle);
  }
  const handle = globalThis.setTimeout(run, IDLE_FALLBACK_MS);
  return (): void => globalThis.clearTimeout(handle);
}

/** Runs `run` once the page is visible. Returns the canceler. */
function whenVisible(doc: Document, run: () => void): () => void {
  const onChange = (): void => {
    if (doc.visibilityState === "hidden") return;
    doc.removeEventListener("visibilitychange", onChange);
    run();
  };
  doc.addEventListener("visibilitychange", onChange);
  return (): void => doc.removeEventListener("visibilitychange", onChange);
}

/** Why the browser's settings hold a load back: it asks for less data, or (for a speculative load) the connection is slow. */
function constrainedBy(speculative: boolean): PrefetchSkipReason | undefined {
  const connection = (globalThis.navigator as { readonly connection?: Connection } | undefined)
    ?.connection;
  if (connection?.saveData === true) return "data-saver";
  const type = connection?.effectiveType;
  return speculative && (type === "slow-2g" || type === "2g") ? "slow-network" : undefined;
}

/** The key of a target: its href without the hash. */
function keyOf(href: string): string {
  const hashAt = href.indexOf("#");
  return hashAt < 0 ? href : href.slice(0, hashAt);
}

/** True for an anchor the browser would not handle as a same-page navigation: another origin, a frame, a download. */
function leavesToBrowser(anchor: Element): boolean {
  const frame = anchor.getAttribute("target");
  if (frame !== null && frame !== "" && frame !== "_self") return true;
  if (anchor.hasAttribute("download")) return true;
  if ((anchor.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("external"))
    return true;
  const origin = (anchor as { readonly origin?: unknown }).origin;
  const here = anchor.ownerDocument.defaultView?.location.origin;
  return typeof origin === "string" && here !== undefined && origin !== here;
}

/** Starts loading the code of the lazy components of the routes a pathname matches. */
function warmChunks(core: RouterCore, pathname: string): Promise<unknown> {
  const jobs: Promise<unknown>[] = [];
  for (const { id } of core.matcher.match(pathname)) {
    const component: unknown = core.specOf(id)?.component;
    if (typeof component === "function" && "preload" in component) {
      const preload: unknown = component.preload;
      if (typeof preload === "function") jobs.push(Promise.resolve(preload.call(component)));
    }
  }
  return Promise.all(jobs);
}

/** One `IntersectionObserver` for every link of a document. */
interface SharedObserver {
  readonly observer: IntersectionObserver;
  readonly handlers: Map<Element, (visible: boolean) => void>;
}

/**
 * The `prefetch` feature: links load their target ahead of a click, by a strategy per link (`<A preload>`) or for the
 * whole router (`strategy`). Loaders run through the router's own preload, so the data lands in the loader cache with
 * its `preloadStaleTime`, and the code of lazy route components is requested too.
 *
 * - `"intent"` (the default): the pointer rests on the link for `intentDelay` (50 ms; leaving cancels), the link takes
 *   keyboard focus, or a touch starts.
 * - `"viewport"`: the link has been visible for `viewportDelay` (100 ms). One `IntersectionObserver` serves the page.
 * - `"render"`: the link is on the page.
 * - `"none"` (or `preload={false}`): never.
 *
 * Every strategy stays polite: nothing loads while the page is hidden (a speculative load waits until it shows), when
 * the browser asks to save data, or for a link that leaves to the browser (another origin, `target`, `download`,
 * `rel="external"`). On a `slow-2g` or `2g` connection `"viewport"` and `"render"` do not load. Loads start when the
 * browser is idle, at most `concurrency` at a time in the order they were asked for; a target that is already loading
 * or loaded recently is not asked for again, and a link that leaves the page cancels its load.
 *
 * The strategy of a link is read when the link mounts (`"intent"` reads it again on every event).
 *
 * @param options See {@link PrefetchOptions}.
 * @returns The feature.
 * @example
 * import { prefetch } from "@shadow-js/router/prefetch";
 * const router = createRouter({ routes, features: [loaderCache(), prefetch({ strategy: "viewport" })] });
 * @since 1.0.0
 */
export function prefetch(options: PrefetchOptions = {}): RouterFeature {
  const fallback = options.strategy ?? "intent";
  const intentDelay = options.intentDelay ?? 50;
  const viewportDelay = options.viewportDelay ?? 100;
  const idleTimeout = options.idleTimeout ?? 2000;
  const freshFor = options.freshFor ?? 30_000;
  return {
    id: "prefetch",
    install(host): void {
      const queue = createPrefetchQueue({
        concurrency: options.concurrency ?? 3,
        onError: host.report,
      });
      const report = options.report;
      const detach = report?.attach(host, freshFor);
      // Target key -> time until which it counts as loaded.
      const loaded = new Map<string, number>();
      const observers = new Map<Document, SharedObserver>();
      const attached = new Set<() => void>();
      host.onDispose(() => {
        detach?.();
        for (const release of [...attached]) release();
        queue.dispose();
        loaded.clear();
      });

      const remember = (key: string): void => {
        loaded.delete(key);
        if (loaded.size >= MAX_REMEMBERED) {
          const oldest = loaded.keys().next();
          if (!oldest.done) loaded.delete(oldest.value);
        }
        loaded.set(key, host.clock.now() + freshFor);
      };
      const isFresh = (key: string): boolean => (loaded.get(key) ?? 0) > host.clock.now();

      const load = async (
        core: RouterCore,
        target: PrefetchTarget,
        key: string,
        strategy: PrefetchStrategy,
        signal: AbortSignal,
      ): Promise<void> => {
        report?.event("started", key, strategy);
        try {
          await Promise.all([
            core.router.preload(target.to as HrefOf, { ...target.options, signal }),
            warmChunks(core, target.pathname),
          ]);
        } catch (error) {
          if (!signal.aborted) host.report(error);
        }
        if (!signal.aborted) {
          remember(key);
          report?.event("loaded", key, strategy);
        }
      };

      const observe = (
        doc: Document,
        anchor: Element,
        handler: (visible: boolean) => void,
      ): (() => void) | undefined => {
        if (typeof IntersectionObserver === "undefined") return undefined;
        let shared = observers.get(doc);
        if (shared === undefined) {
          const handlers = new Map<Element, (visible: boolean) => void>();
          const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) handlers.get(entry.target)?.(entry.isIntersecting);
          });
          shared = { observer, handlers };
          observers.set(doc, shared);
        }
        const current = shared;
        current.handlers.set(anchor, handler);
        current.observer.observe(anchor);
        return (): void => {
          if (current.handlers.get(anchor) !== handler) return;
          current.handlers.delete(anchor);
          current.observer.unobserve(anchor);
          if (current.handlers.size === 0) {
            current.observer.disconnect();
            observers.delete(doc);
          }
        };
      };

      const capability: PrefetchCapability = {
        attach(
          core: RouterCore,
          anchor: Element,
          link: () => PrefetchLink,
          props: { readonly preload?: PrefetchStrategy | false | undefined },
        ): () => void {
          const doc = anchor.ownerDocument;
          // The stage the link's load is in (waiting for the page to show, for idle, queued or running).
          let cancelStage: (() => void) | undefined;
          let hover: ReturnType<typeof setTimeout> | undefined;
          let dwell: ReturnType<typeof setTimeout> | undefined;
          let stopWatching: (() => void) | undefined;

          const strategy = (): PrefetchStrategy => {
            const own = props.preload;
            return own === false ? "none" : (own ?? fallback);
          };

          const submit = (speculative: boolean): void => {
            if (cancelStage !== undefined) return;
            const target = link();
            if (target.kind !== "route") return;
            const key = keyOf(target.href);
            const held = leavesToBrowser(anchor) ? "leaves-site" : constrainedBy(speculative);
            if (held !== undefined || isFresh(key)) {
              report?.event("skipped", key, strategy(), held ?? "fresh");
              return;
            }
            const start = (): void => {
              let ran = false;
              const cancelIdle = whenIdle(
                () => {
                  ran = true;
                  if (doc.visibilityState === "hidden") {
                    cancelStage = undefined;
                    if (speculative) submit(true);
                    return;
                  }
                  const ticket: PrefetchTicket = queue.enqueue(key, (signal) =>
                    load(core, target, key, strategy(), signal),
                  );
                  const stop = (): void => ticket.cancel();
                  cancelStage = stop;
                  void ticket.done.then(() => {
                    if (cancelStage === stop) cancelStage = undefined;
                  });
                },
                speculative ? idleTimeout : INTENT_IDLE_MS,
              );
              if (!ran) cancelStage = cancelIdle;
            };
            if (doc.visibilityState !== "hidden") {
              start();
            } else if (speculative) {
              cancelStage = whenVisible(doc, () => {
                cancelStage = undefined;
                submit(true);
              });
            }
          };

          const onEnter = (): void => {
            if (strategy() !== "intent") return;
            if (hover !== undefined) globalThis.clearTimeout(hover);
            hover = globalThis.setTimeout(() => {
              hover = undefined;
              submit(false);
            }, intentDelay);
          };
          const onLeave = (): void => {
            if (hover !== undefined) globalThis.clearTimeout(hover);
            hover = undefined;
          };
          const onNow = (): void => {
            if (strategy() === "intent") submit(false);
          };

          const events: readonly [string, () => void, AddEventListenerOptions?][] = [
            ["mouseenter", onEnter],
            ["mouseleave", onLeave],
            ["focus", onNow],
            ["touchstart", onNow, { passive: true }],
          ];
          for (const [type, handler, listenerOptions] of events) {
            anchor.addEventListener(type, handler, listenerOptions);
          }

          const mode = strategy();
          const heldBack =
            mode === "render" || mode === "viewport" ? constrainedBy(true) : undefined;
          if (heldBack !== undefined) {
            const target = link();
            if (target.kind === "route")
              report?.event("skipped", keyOf(target.href), mode, heldBack);
          } else if (mode === "render") {
            submit(true);
          } else if (mode === "viewport") {
            stopWatching = observe(doc, anchor, (visible) => {
              if (dwell !== undefined) globalThis.clearTimeout(dwell);
              dwell = undefined;
              if (!visible) return;
              dwell = globalThis.setTimeout(() => {
                dwell = undefined;
                stopWatching?.();
                stopWatching = undefined;
                submit(true);
              }, viewportDelay);
            });
          }

          const release = (): void => {
            attached.delete(release);
            for (const [type, handler, listenerOptions] of events) {
              anchor.removeEventListener(type, handler, listenerOptions);
            }
            if (hover !== undefined) globalThis.clearTimeout(hover);
            if (dwell !== undefined) globalThis.clearTimeout(dwell);
            hover = undefined;
            dwell = undefined;
            stopWatching?.();
            stopWatching = undefined;
            const cancel = cancelStage;
            cancelStage = undefined;
            if (cancel !== undefined) {
              const target = link();
              if (target.kind === "route")
                report?.event("canceled", keyOf(target.href), strategy());
              cancel();
            }
          };
          attached.add(release);
          return release;
        },
      };
      host.capabilities.prefetch = capability;
    },
  };
}
