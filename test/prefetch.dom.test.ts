import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "../src/core/history";
import { type PrefetchOptions, prefetch } from "../src/features/prefetch";
import {
  createPrefetchReport,
  type PrefetchEvent,
  summarizePrefetch,
} from "../src/features/prefetch-report";
import type { Capabilities, FeatureHost, PrefetchLink } from "../src/internal/capabilities";
import type { RouterCore } from "../src/internal/core";
import type { PrefetchStrategy } from "../src/types";
import { FakeIntersectionObserver } from "./support/fake-intersection-observer";

/** One load the fake router was asked for. */
interface Load {
  readonly to: string;
  readonly signal: AbortSignal;
  finish(): void;
  fail(error: unknown): void;
}

/** A requestIdleCallback the test runs by hand. */
interface Idle {
  readonly timeouts: number[];
  readonly canceled: number[];
  flush(): void;
}

interface Setup {
  readonly history: ReturnType<typeof createMemoryHistory>;
  readonly loads: Load[];
  readonly reports: unknown[];
  readonly chunks: string[];
  idle: Idle | undefined;
  link(
    href: string,
    strategy?: PrefetchStrategy | false,
    attributes?: Record<string, string>,
  ): { readonly anchor: HTMLAnchorElement; release(): void };
  dispose(): void;
}

/** Installs the feature on a fake host and a fake router core that records every preload. */
function setup(
  options: PrefetchOptions = {},
  routes: Record<string, { ids: string[]; lazy?: boolean }> = {},
): Setup {
  const capabilities: Capabilities = {};
  const reports: unknown[] = [];
  const disposers: (() => void)[] = [];
  const loads: Load[] = [];
  const chunks: string[] = [];
  const history = createMemoryHistory();
  const host: FeatureHost = {
    window: undefined,
    history,
    clock: {
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
    report: (error) => reports.push(error),
    currentIndex: () => 0,
    capabilities,
    onDispose: (run) => disposers.push(run),
  };
  prefetch(options).install(host);
  const core = {
    router: {
      preload(to: string, preloadOptions: { signal: AbortSignal }): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          loads.push({ to, signal: preloadOptions.signal, finish: resolve, fail: reject });
        });
      },
    },
    specOf(id: string) {
      const lazy = Object.values(routes).some(
        (route) => route.lazy === true && route.ids.includes(id),
      );
      const component = lazy
        ? Object.assign(() => null, {
            preload: (): Promise<void> => {
              chunks.push(id);
              return Promise.resolve();
            },
          })
        : () => null;
      return { component };
    },
    matcher: { match: (pathname: string) => (routes[pathname]?.ids ?? []).map((id) => ({ id })) },
  } as unknown as RouterCore;

  const state: Setup = {
    history,
    loads,
    reports,
    chunks,
    idle: undefined,
    link(href, strategy, attributes = {}) {
      const anchor = document.createElement("a");
      anchor.setAttribute("href", href);
      for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
      document.body.appendChild(anchor);
      const link = (): PrefetchLink => ({
        kind: "route",
        to: href,
        options: {},
        pathname: href,
        href,
      });
      const release =
        capabilities.prefetch?.attach(core, anchor, link, { preload: strategy }) ??
        (() => undefined);
      return { anchor, release };
    },
    dispose() {
      for (const run of disposers.splice(0)) run();
    },
  };
  return state;
}

/** Replaces requestIdleCallback with a queue the test flushes. */
function fakeIdle(): Idle {
  const callbacks = new Map<number, () => void>();
  const timeouts: number[] = [];
  const canceled: number[] = [];
  let next = 1;
  vi.stubGlobal("requestIdleCallback", (run: () => void, options: { timeout: number }): number => {
    const id = next;
    next += 1;
    callbacks.set(id, run);
    timeouts.push(options.timeout);
    return id;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number): void => {
    canceled.push(id);
    callbacks.delete(id);
  });
  return {
    timeouts,
    canceled,
    flush(): void {
      for (const [id, run] of [...callbacks]) {
        callbacks.delete(id);
        run();
      }
    },
  };
}

/** Sets what `navigator.connection` reports. */
function connection(value: { saveData?: boolean; effectiveType?: string } | undefined): void {
  Object.defineProperty(navigator, "connection", { value, configurable: true });
}

/** Sets `document.visibilityState`. */
function visibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { get: () => state, configurable: true });
}

/** Lets the promise chains of a finished load run (fake timers do not stop microtasks). */
async function ticks(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

const hover = (anchor: Element): boolean => anchor.dispatchEvent(new MouseEvent("mouseenter"));

let idle: Idle;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  FakeIntersectionObserver.reset();
  idle = fakeIdle();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  connection(undefined);
  visibility("visible");
  document.body.innerHTML = "";
});

describe("prefetch: intent", () => {
  it("[ROUTER-PREFETCH-10] hovering for the delay loads the target once the browser is idle", () => {
    const s = setup();
    const { anchor } = s.link("/p/1");
    hover(anchor);
    vi.advanceTimersByTime(49);
    idle.flush();
    expect(s.loads).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(s.loads).toHaveLength(0);
    idle.flush();
    expect(s.loads.map((load) => load.to)).toEqual(["/p/1"]);
    expect(idle.timeouts).toEqual([100]);
  });

  it("[ROUTER-PREFETCH-11] leaving the link before the delay cancels the load; intentDelay is configurable", () => {
    const s = setup({ intentDelay: 200 });
    const { anchor } = s.link("/p/1");
    hover(anchor);
    vi.advanceTimersByTime(150);
    anchor.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(500);
    idle.flush();
    expect(s.loads).toHaveLength(0);
    hover(anchor);
    vi.advanceTimersByTime(200);
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it.each(["focus", "touchstart"])(
    "[ROUTER-PREFETCH-12] %s loads without the hover delay",
    (type) => {
      const s = setup();
      const { anchor } = s.link("/p/1");
      anchor.dispatchEvent(new Event(type));
      idle.flush();
      expect(s.loads).toHaveLength(1);
    },
  );

  it("[ROUTER-PREFETCH-13] a link whose strategy is not intent ignores hover, focus and touch", () => {
    const s = setup();
    for (const strategy of ["none", "viewport", false] as const) {
      const { anchor } = s.link(`/p/${String(strategy)}`, strategy);
      hover(anchor);
      anchor.dispatchEvent(new Event("focus"));
      anchor.dispatchEvent(new Event("touchstart"));
    }
    vi.advanceTimersByTime(1000);
    idle.flush();
    expect(s.loads).toHaveLength(0);
  });
});

describe("prefetch: viewport and render", () => {
  it("[ROUTER-PREFETCH-14] viewport loads a link after it has been visible for 100 ms, with one observer for the page", () => {
    const s = setup();
    const first = s.link("/p/1", "viewport");
    const second = s.link("/p/2", "viewport");
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const observer = FakeIntersectionObserver.instances[0];
    expect(observer?.targets).toEqual([first.anchor, second.anchor]);
    observer?.report(first.anchor, true);
    vi.advanceTimersByTime(99);
    idle.flush();
    expect(s.loads).toHaveLength(0);
    vi.advanceTimersByTime(1);
    idle.flush();
    expect(s.loads.map((load) => load.to)).toEqual(["/p/1"]);
    expect(idle.timeouts).toEqual([2000]);
    // A link that fired is no longer watched.
    expect(observer?.targets).toEqual([second.anchor]);
  });

  it("[ROUTER-PREFETCH-15] a link that leaves the viewport before 100 ms is not loaded", () => {
    const s = setup();
    const { anchor } = s.link("/p/1", "viewport");
    const observer = FakeIntersectionObserver.instances[0];
    observer?.report(anchor, true);
    vi.advanceTimersByTime(60);
    observer?.report(anchor, false);
    vi.advanceTimersByTime(500);
    idle.flush();
    expect(s.loads).toHaveLength(0);
    observer?.report(anchor, true);
    vi.advanceTimersByTime(100);
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it("[ROUTER-PREFETCH-16] viewportDelay is configurable and the router default strategy applies to links without one", () => {
    const s = setup({ strategy: "viewport", viewportDelay: 300 });
    const { anchor } = s.link("/p/1");
    const observer = FakeIntersectionObserver.instances[0];
    observer?.report(anchor, true);
    vi.advanceTimersByTime(299);
    idle.flush();
    expect(s.loads).toHaveLength(0);
    vi.advanceTimersByTime(1);
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it("[ROUTER-PREFETCH-17] a link's own strategy beats the router default", () => {
    const s = setup({ strategy: "render" });
    s.link("/p/1", "none");
    s.link("/p/2", false);
    idle.flush();
    expect(s.loads).toHaveLength(0);
    s.link("/p/3");
    idle.flush();
    expect(s.loads.map((load) => load.to)).toEqual(["/p/3"]);
  });

  it("[ROUTER-PREFETCH-18] render loads a link as soon as it is mounted", () => {
    const s = setup();
    s.link("/p/1", "render");
    idle.flush();
    expect(s.loads.map((load) => load.to)).toEqual(["/p/1"]);
    expect(idle.timeouts).toEqual([2000]);
  });

  it("[ROUTER-PREFETCH-19] without IntersectionObserver a viewport link does nothing and nothing throws", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const s = setup();
    s.link("/p/1", "viewport");
    vi.advanceTimersByTime(1000);
    idle.flush();
    expect(s.loads).toHaveLength(0);
  });
});

describe("prefetch: budgets", () => {
  it("[ROUTER-PREFETCH-20] saveData disables every strategy", () => {
    connection({ saveData: true, effectiveType: "4g" });
    const s = setup();
    const intent = s.link("/p/1");
    s.link("/p/2", "render");
    s.link("/p/3", "viewport");
    hover(intent.anchor);
    intent.anchor.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(1000);
    idle.flush();
    expect(s.loads).toHaveLength(0);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it.each(["slow-2g", "2g"])(
    "[ROUTER-PREFETCH-21] on %s, render and viewport are off but intent still loads",
    (effectiveType) => {
      connection({ effectiveType });
      const s = setup();
      s.link("/p/2", "render");
      s.link("/p/3", "viewport");
      idle.flush();
      expect(s.loads).toHaveLength(0);
      expect(FakeIntersectionObserver.instances).toHaveLength(0);
      const { anchor } = s.link("/p/1");
      anchor.dispatchEvent(new Event("focus"));
      idle.flush();
      expect(s.loads.map((load) => load.to)).toEqual(["/p/1"]);
    },
  );

  it("[ROUTER-PREFETCH-22] on a 4g connection render loads", () => {
    connection({ effectiveType: "4g", saveData: false });
    const s = setup();
    s.link("/p/1", "render");
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it("[ROUTER-PREFETCH-23] at most three loads run at once; the rest wait in the order they were asked for", async () => {
    const s = setup();
    for (const n of [1, 2, 3, 4, 5]) s.link(`/p/${n}`, "render");
    idle.flush();
    expect(s.loads.map((load) => load.to)).toEqual(["/p/1", "/p/2", "/p/3"]);
    s.loads[1]?.finish();
    await ticks();
    expect(s.loads.map((load) => load.to)).toEqual(["/p/1", "/p/2", "/p/3", "/p/4"]);
  });

  it("[ROUTER-PREFETCH-24] concurrency is configurable", () => {
    const s = setup({ concurrency: 1 });
    for (const n of [1, 2]) s.link(`/p/${n}`, "render");
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it("[ROUTER-PREFETCH-25] a speculative load waits while the page is hidden and runs when it shows", () => {
    visibility("hidden");
    const s = setup();
    s.link("/p/1", "render");
    idle.flush();
    expect(s.loads).toHaveLength(0);
    visibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it("[ROUTER-PREFETCH-26] intent loads nothing while the page is hidden, even if it hides during the wait", () => {
    const s = setup();
    const { anchor } = s.link("/p/1");
    hover(anchor);
    vi.advanceTimersByTime(50);
    visibility("hidden");
    idle.flush();
    expect(s.loads).toHaveLength(0);
    visibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    idle.flush();
    expect(s.loads).toHaveLength(0);
  });

  it("[ROUTER-PREFETCH-27] without requestIdleCallback the load starts from a timer", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const s = setup();
    s.link("/p/1", "render");
    expect(s.loads).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(s.loads).toHaveLength(1);
  });
});

describe("prefetch: which links", () => {
  it.each([
    ["target=_blank", { target: "_blank" }],
    ["download", { download: "" }],
    ["rel=external", { rel: "noopener external" }],
  ])("[ROUTER-PREFETCH-28] a link with %s is never loaded", (_name, attributes) => {
    const s = setup();
    const { anchor } = s.link("/p/1", "render", attributes);
    anchor.dispatchEvent(new Event("focus"));
    idle.flush();
    expect(s.loads).toHaveLength(0);
  });

  it("[ROUTER-PREFETCH-29] target=_self still loads", () => {
    const s = setup();
    s.link("/p/1", "render", { target: "_self" });
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it("[ROUTER-PREFETCH-30] a link to another origin is never loaded", () => {
    const s = setup();
    s.link("https://other.example/p/1", "render");
    idle.flush();
    expect(s.loads).toHaveLength(0);
  });
});

describe("prefetch: dedupe and lifetime", () => {
  it("[ROUTER-PREFETCH-31] two links to one target share one load, and a loaded target is not loaded again until freshFor passes", async () => {
    const s = setup({ freshFor: 1000 });
    s.link("/p/1", "render");
    s.link("/p/1", "render");
    idle.flush();
    expect(s.loads).toHaveLength(1);
    s.loads[0]?.finish();
    await ticks();
    const again = s.link("/p/1");
    again.anchor.dispatchEvent(new Event("focus"));
    idle.flush();
    expect(s.loads).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    again.anchor.dispatchEvent(new Event("focus"));
    idle.flush();
    expect(s.loads).toHaveLength(2);
  });

  it("[ROUTER-PREFETCH-32] a target differing only by hash counts as the same load", () => {
    const s = setup();
    s.link("/p/1#a", "render");
    s.link("/p/1#b", "render");
    idle.flush();
    expect(s.loads).toHaveLength(1);
  });

  it("[ROUTER-PREFETCH-33] releasing a link cancels its running load, its queued load and its timers", () => {
    const s = setup({ concurrency: 1 });
    const running = s.link("/p/1", "render");
    const queued = s.link("/p/2", "render");
    const hovered = s.link("/p/3");
    idle.flush();
    hover(hovered.anchor);
    expect(s.loads).toHaveLength(1);
    running.release();
    expect(s.loads[0]?.signal.aborted).toBe(true);
    // The slot is free again, but the queued link was released first.
    queued.release();
    hovered.release();
    vi.advanceTimersByTime(1000);
    idle.flush();
    // The queued link took the freed slot, then was released too; the hovered one never started.
    expect(s.loads.map((load) => load.to)).toEqual(["/p/1", "/p/2"]);
    expect(s.loads.every((load) => load.signal.aborted)).toBe(true);
  });

  it("[ROUTER-PREFETCH-34] releasing a link before its idle callback cancels the idle callback", () => {
    const s = setup();
    const { release } = s.link("/p/1", "render");
    release();
    expect(idle.canceled).toHaveLength(1);
    idle.flush();
    expect(s.loads).toHaveLength(0);
  });

  it("[ROUTER-PREFETCH-35] after release the anchor no longer reacts and the observer lets go of it", () => {
    const s = setup();
    const events = s.link("/p/1");
    const watched = s.link("/p/2", "viewport");
    const observer = FakeIntersectionObserver.instances[0];
    expect(observer?.targets).toEqual([watched.anchor]);
    events.release();
    watched.release();
    expect(observer?.targets).toEqual([]);
    hover(events.anchor);
    events.anchor.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(1000);
    idle.flush();
    expect(s.loads).toHaveLength(0);
  });

  it("[ROUTER-PREFETCH-36] a shared load keeps running until every link that asked for it has left", () => {
    const s = setup();
    const one = s.link("/p/1", "render");
    const two = s.link("/p/1", "render");
    idle.flush();
    one.release();
    expect(s.loads[0]?.signal.aborted).toBe(false);
    two.release();
    expect(s.loads[0]?.signal.aborted).toBe(true);
  });

  it("[ROUTER-PREFETCH-37] disposing the router releases every link and aborts the running loads", () => {
    const s = setup();
    const { anchor } = s.link("/p/1", "render");
    const watched = s.link("/p/2", "viewport");
    idle.flush();
    s.dispose();
    expect(s.loads[0]?.signal.aborted).toBe(true);
    expect(FakeIntersectionObserver.instances[0]?.targets).toEqual([]);
    anchor.dispatchEvent(new Event("focus"));
    idle.flush();
    expect(s.loads).toHaveLength(1);
    watched.release();
  });

  it("[ROUTER-PREFETCH-38] an aborted load is not remembered as loaded", () => {
    const s = setup();
    const first = s.link("/p/1", "render");
    idle.flush();
    first.release();
    s.link("/p/1", "render");
    idle.flush();
    expect(s.loads).toHaveLength(2);
  });
});

describe("prefetch: code and failures", () => {
  it("[ROUTER-PREFETCH-39] the lazy component chunks of the matched routes are requested with the data", () => {
    const s = setup(
      {},
      { "/p/1": { ids: ["shell", "post"], lazy: true }, "/p/2": { ids: ["plain"] } },
    );
    s.link("/p/1", "render");
    s.link("/p/2", "render");
    idle.flush();
    expect(s.chunks).toEqual(["shell", "post"]);
  });

  it("[ROUTER-PREFETCH-40] a failed load is reported once and does not stop later links", async () => {
    const s = setup();
    s.link("/p/1", "render");
    s.link("/p/2", "render");
    idle.flush();
    s.loads[0]?.fail(new Error("offline"));
    await ticks();
    expect(s.reports).toHaveLength(1);
    expect(s.loads).toHaveLength(2);
  });
});

describe("prefetch: report", () => {
  /** A setup whose `report` option records every event. */
  function reported(options: PrefetchOptions = {}): Setup & { readonly events: PrefetchEvent[] } {
    const events: PrefetchEvent[] = [];
    const report = createPrefetchReport({ onEvent: (event) => events.push(event) });
    return Object.assign(setup({ ...options, report }), { events });
  }

  it("[ROUTER-PREFETCH-60] each load reports when it started and finished, with the strategy that asked for it", async () => {
    const s = reported();
    const intent = s.link("/a");
    const viewport = s.link("/b", "viewport");
    hover(intent.anchor);
    vi.advanceTimersByTime(50);
    FakeIntersectionObserver.instances[0]?.report(viewport.anchor, true);
    vi.advanceTimersByTime(100);
    idle.flush();
    vi.advanceTimersByTime(25);
    s.loads[0]?.finish();
    await ticks();
    vi.advanceTimersByTime(10);
    s.loads[1]?.finish();
    await ticks();
    expect(s.events.map((event) => [event.kind, event.href, event.strategy])).toEqual([
      ["started", "/a", "intent"],
      ["started", "/b", "viewport"],
      ["loaded", "/a", "intent"],
      ["loaded", "/b", "viewport"],
    ]);
    const loaded = s.events.filter((event) => event.kind === "loaded");
    expect(loaded.map((event) => event.ms)).toEqual([25, 35]);
  });

  it("[ROUTER-PREFETCH-61] a navigation to a loaded target reports it used once, and a navigation elsewhere reports nothing", async () => {
    const s = reported();
    const { anchor } = s.link("/a", "render");
    idle.flush();
    s.loads[0]?.finish();
    await ticks();
    s.history.push("/elsewhere");
    expect(s.events.some((event) => event.kind === "used")).toBe(false);
    vi.advanceTimersByTime(3000);
    s.history.push("/a");
    s.history.push("/b");
    s.history.push("/a");
    const used = s.events.filter((event) => event.kind === "used");
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ kind: "used", href: "/a", strategy: "render", ageMs: 3000 });
    anchor.remove();
  });

  it("[ROUTER-PREFETCH-62] a target used after freshFor has run out is not counted as used", async () => {
    const s = reported({ freshFor: 1000 });
    s.link("/a", "render");
    idle.flush();
    s.loads[0]?.finish();
    await ticks();
    vi.advanceTimersByTime(1500);
    s.history.push("/a");
    expect(s.events.some((event) => event.kind === "used")).toBe(false);
  });

  it("[ROUTER-PREFETCH-63] a link that is skipped says why: data saver, slow network, leaves the site, or fresh", async () => {
    const s = reported();
    connection({ saveData: true });
    s.link("/saver", "render");
    connection({ effectiveType: "2g" });
    s.link("/slow", "viewport");
    connection(undefined);
    s.link("/away", "render", { target: "_blank" });
    s.link("/fresh", "render");
    idle.flush();
    s.loads[0]?.finish();
    await ticks();
    s.link("/fresh", "render");
    const skipped = s.events.filter((event) => event.kind === "skipped");
    expect(skipped.map((event) => [event.href, event.reason])).toEqual([
      ["/saver", "data-saver"],
      ["/slow", "slow-network"],
      ["/away", "leaves-site"],
      ["/fresh", "fresh"],
    ]);
  });

  it("[ROUTER-PREFETCH-64] leaving the page before a queued load runs reports it canceled", () => {
    const s = reported();
    const { release } = s.link("/a", "render");
    release();
    expect(s.events.map((event) => event.kind)).toContain("canceled");
  });

  it("[ROUTER-PREFETCH-65] summarizePrefetch counts by strategy: started, loaded, used, wasted, and the hit rate", () => {
    const events: PrefetchEvent[] = [
      { kind: "started", href: "/a", strategy: "intent", at: 0 },
      { kind: "loaded", href: "/a", strategy: "intent", at: 10, ms: 10 },
      { kind: "used", href: "/a", strategy: "intent", at: 500, ageMs: 490 },
      { kind: "started", href: "/b", strategy: "viewport", at: 0 },
      { kind: "loaded", href: "/b", strategy: "viewport", at: 20, ms: 20 },
      { kind: "started", href: "/c", strategy: "viewport", at: 0 },
      { kind: "loaded", href: "/c", strategy: "viewport", at: 30, ms: 30 },
      { kind: "started", href: "/d", strategy: "viewport", at: 0 },
      { kind: "canceled", href: "/d", strategy: "viewport", at: 5 },
      { kind: "skipped", href: "/e", strategy: "render", at: 0, reason: "data-saver" },
    ];
    expect(summarizePrefetch(events)).toEqual({
      intent: { started: 1, loaded: 1, canceled: 0, skipped: 0, used: 1, wasted: 0, hitRate: 1 },
      viewport: { started: 3, loaded: 2, canceled: 1, skipped: 0, used: 0, wasted: 2, hitRate: 0 },
      render: {
        started: 0,
        loaded: 0,
        canceled: 0,
        skipped: 1,
        used: 0,
        wasted: 0,
        hitRate: undefined,
      },
      total: { started: 4, loaded: 3, canceled: 1, skipped: 1, used: 1, wasted: 2, hitRate: 1 / 3 },
    });
  });
});
