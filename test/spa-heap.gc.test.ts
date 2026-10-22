import { createRoot, flushSync, useEffect, useSignal } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { loaderCache } from "../src/features/loaders";
import { createMemoryHistory, createRouter, defineRoute, type Router } from "../src/index";

/*
 * Long-lived SPA heap checks. The gc project runs in node, so the DOM render path is not available.
 * Each navigation mounts a view (a root with a signal and an effect that reads `router.state.matches()`)
 * in place of an `<Outlet />`, and disposes the previous view. That exercises the same router, loader cache,
 * history and reactive owner paths a rendered app uses.
 */

const MB = 1024 * 1024;
const WARM_UP_NAVIGATIONS = 500;
const TOTAL_NAVIGATIONS = 3000;
const RETAINED_GROWTH_BOUND = 8 * MB;
const PATHS = ["/", "/a", "/items/1", "/items/2", "/c"] as const;

const routes = [
  defineRoute("/", { loader: () => ({ kind: "home" }) }),
  defineRoute("/a", { loader: () => ({ kind: "a" }) }),
  defineRoute("/items/:id", { loader: ({ params }) => ({ id: params.id }) }),
  defineRoute("/c", { loader: () => ({ kind: "c" }) }),
];

/** A view root owned by one navigation. `probe` stands for memory the component owns. */
interface View {
  readonly probe: { readonly label: string; readonly payload: Uint8Array };
  dispose(): void;
}

interface App {
  readonly router: Router;
  view: View;
}

function forceGc(): void {
  const gc = Reflect.get(globalThis, "gc");
  if (typeof gc !== "function") {
    throw new Error("gc is not exposed; run this file through the gc project (--expose-gc)");
  }
  Reflect.apply(gc, globalThis, []);
  Reflect.apply(gc, globalThis, []);
}

/** Several rounds: older engines (Node 22.12) keep the newest objects alive after the first collections. */
async function settleAndCollect(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    forceGc();
  }
}

function mountView(router: Router, label: string): View {
  return createRoot((dispose) => {
    const probe = { label, payload: new Uint8Array(4096) };
    const [, setMatchCount] = useSignal(0);
    useEffect(() => {
      const matches = router.state.matches();
      setMatchCount(matches.length);
      probe.payload[0] = matches.length;
    });
    return { probe, dispose };
  });
}

async function boot(): Promise<App> {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ routes, history, features: [loaderCache()] });
  await router.ready();
  const view = mountView(router, "boot");
  flushSync();
  return { router, view };
}

/** Navigates to the next path in the round robin, then replaces the view that the navigation mounted. */
async function step(app: App, index: number): Promise<void> {
  const path = PATHS[index % PATHS.length] as (typeof PATHS)[number];
  await app.router.navigate(path);
  app.view.dispose();
  app.view = mountView(app.router, path);
  flushSync();
}

/**
 * Runs the long session in its own call frame so the app, router and views go out of scope before the
 * final measurement. Returns the heap after warm-up and the growth samples taken while the session ran.
 */
async function longSession(): Promise<{ baseline: number; samples: string[] }> {
  const app = await boot();
  for (let i = 0; i < WARM_UP_NAVIGATIONS; i += 1) {
    await step(app, i);
  }
  await settleAndCollect();
  const baseline = process.memoryUsage().heapUsed;

  const samples: string[] = [];
  for (let i = WARM_UP_NAVIGATIONS; i < TOTAL_NAVIGATIONS; i += 1) {
    await step(app, i);
    if ((i + 1) % 500 === 0) {
      await settleAndCollect();
      const used = process.memoryUsage().heapUsed;
      samples.push(`${i + 1}:${((used - baseline) / MB).toFixed(2)}MB`);
    }
  }

  app.view.dispose();
  app.router.dispose();
  return { baseline, samples };
}

describe("long-lived SPA heap", () => {
  it("[SPA-HEAP-01] retained heap stays under 8 MB across 3,000 round-robin navigations", async () => {
    const { baseline, samples } = await longSession();
    await settleAndCollect();
    const after = process.memoryUsage().heapUsed;
    const growth = after - baseline;

    console.log(
      `[SPA-HEAP-01] baseline=${(baseline / MB).toFixed(2)}MB after=${(after / MB).toFixed(2)}MB ` +
        `growth=${(growth / MB).toFixed(2)}MB bound=${(RETAINED_GROWTH_BOUND / MB).toFixed(2)}MB ` +
        `samples=[${samples.join(" ")}]`,
    );
    expect(growth).toBeLessThan(RETAINED_GROWTH_BOUND);
  }, 120_000);

  it("[SPA-HEAP-02] a component-owned object from an early route is collected after dispose", async () => {
    const app = await boot();
    await app.router.navigate("/a");
    app.view.dispose();
    app.view = mountView(app.router, "early-a");
    flushSync();
    const early = new WeakRef(app.view.probe);

    for (let i = 0; i < 300; i += 1) {
      await step(app, i);
    }

    app.view.dispose();
    app.router.dispose();
    await settleAndCollect();
    const alive = early.deref() !== undefined;
    console.log(`[SPA-HEAP-02] early route probe collected=${!alive}`);
    expect(early.deref()).toBeUndefined();
  }, 120_000);

  it("[SPA-HEAP-03] the router and its history are collected after dispose", async () => {
    const refs = await (async () => {
      const history = createMemoryHistory({ initialEntries: ["/"] });
      const router = createRouter({ routes, history, features: [loaderCache()] });
      await router.ready();
      const app: App = { router, view: mountView(router, "boot") };
      flushSync();
      for (let i = 0; i < 200; i += 1) {
        await step(app, i);
      }
      app.view.dispose();
      router.dispose();
      return { router: new WeakRef(router), history: new WeakRef(history) };
    })();

    await settleAndCollect();
    console.log(
      `[SPA-HEAP-03] router collected=${refs.router.deref() === undefined} ` +
        `history collected=${refs.history.deref() === undefined}`,
    );
    expect(refs.router.deref()).toBeUndefined();
    expect(refs.history.deref()).toBeUndefined();
  }, 120_000);
});
