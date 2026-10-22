import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { FakeIntersectionObserver } from "./support/fake-intersection-observer";
import { RouterTestWindow } from "./support/router-window";

interface PrefetchModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    options?: Record<string, unknown>,
  ): { dispose(): void };
  loaded: string[];
  chunks: string[];
}

/**
 * Renders `links` under a router that has the prefetch feature. Every loader records its route in `loaded`; the
 * `docs` route has a lazy component whose loader records in `chunks`.
 */
async function page(links: string): Promise<PrefetchModule> {
  return load<PrefetchModule>(`
    import { createRouter, defineRoute, RouterProvider, Outlet, A } from "@router";
    import { prefetch } from "@router/prefetch";
    import { lazy } from "@shadow-js/web";
    import { render } from "@shadow-js/web";
    export const loaded = [];
    export const chunks = [];
    const home = defineRoute("/", { id: "home", component: () => <p>home</p> });
    const list = defineRoute("/list", { id: "list", loader: () => { loaded.push("list"); return 1; }, component: () => <p>list</p> });
    const posts = defineRoute("/posts/:id", { id: "posts", loader: ({ params }) => { loaded.push("post:" + params.id); return 1; }, component: () => <p>post</p> });
    const Docs = lazy(() => { chunks.push("docs"); return Promise.resolve({ default: () => <p>docs</p> }); });
    const docs = defineRoute("/docs", { id: "docs", component: Docs });
    function Page() {
      return <div><nav>${links}</nav><Outlet /></div>;
    }
    const shell = defineRoute("", { id: "shell", component: Page, children: [home, list, posts, docs] });
    export function start(host, win, options = {}) {
      const router = createRouter({
        features: featuresWith(prefetch(options)),
        routes: [shell],
        window: win,
      });
      render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
      return { dispose: () => router.dispose() };
    }
  `);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  FakeIntersectionObserver.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets timers (the idle fallback) and promise chains run. */
async function run(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

describe("A with the prefetch feature", () => {
  it("[ROUTER-PREFETCH-50] hovering a link runs its loader through the router and warms the lazy component", async () => {
    const mod = await page(`<A to="/list" class="go">l</A><A to="/docs" class="docs">d</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    root.querySelector("a.go")?.dispatchEvent(new MouseEvent("mouseenter"));
    await run(49);
    expect(mod.loaded).toEqual([]);
    await run(50);
    expect(mod.loaded).toEqual(["list"]);
    root.querySelector("a.docs")?.dispatchEvent(new Event("focus"));
    await run(50);
    expect(mod.chunks).toEqual(["docs"]);
    router.dispose();
  });

  it("[ROUTER-PREFETCH-51] render loads on mount, preload=none and false never load, and a prop beats the router default", async () => {
    const mod = await page(
      `<A to="/list" preload="render">a</A><A to="/posts/:id" params={{ id: "1" }} preload="none">b</A><A to="/posts/:id" params={{ id: "2" }} preload={false}>c</A>`,
    );
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), { strategy: "viewport" });
    await settle();
    await run(3000);
    expect(mod.loaded).toEqual(["list"]);
    router.dispose();
  });

  it("[ROUTER-PREFETCH-52] the router default applies to links that set no preload", async () => {
    const mod = await page(`<A to="/list" class="go">a</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), { strategy: "viewport" });
    await settle();
    const anchor = root.querySelector("a.go") as Element;
    FakeIntersectionObserver.instances[0]?.report(anchor, true);
    await run(100);
    await run(5);
    expect(mod.loaded).toEqual(["list"]);
    router.dispose();
  });

  it("[ROUTER-PREFETCH-53] the built-in preloading is off: a link does not preload twice", async () => {
    const mod = await page(`<A to="/list" class="go">a</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    root.querySelector("a.go")?.dispatchEvent(new Event("focus"));
    await run(10);
    root.querySelector("a.go")?.dispatchEvent(new Event("touchstart"));
    await run(10);
    expect(mod.loaded).toEqual(["list"]);
    router.dispose();
  });

  it("[ROUTER-PREFETCH-54] disposing the router removes the link listeners and observers", async () => {
    const mod = await page(`<A to="/list" class="go" preload="viewport">a</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    expect(FakeIntersectionObserver.instances[0]?.targets).toHaveLength(1);
    router.dispose();
    expect(FakeIntersectionObserver.instances[0]?.targets).toHaveLength(0);
  });
});
