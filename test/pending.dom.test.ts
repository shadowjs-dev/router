import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock, type FakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

interface PendingModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    clock: FakeClock,
    options: { pendingMs?: number; pendingMinMs?: number },
  ): {
    navigate(to: string): Promise<unknown>;
    dispose(): void;
    state: { pending(): boolean };
  };
  release(): void;
  holdNext(): void;
}

/**
 * Pages: `fast` loads at once, `slow` waits for `release()`. `held` loads (after `holdNext()`) wait
 * too, which lets a test show cached data being refreshed.
 */
const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
  import { render } from "@shadow-js/web";

  let waiting = [];
  let holding = false;
  export function release() { const pending = waiting; waiting = []; for (const resolve of pending) resolve(); }
  export function holdNext() { holding = true; }
  function hold() {
    if (!holding) return Promise.resolve("ok");
    holding = false;
    return new Promise((resolve) => { waiting.push(() => resolve("held")); });
  }
  const fast = defineRoute("/fast", { id: "fast", loader: () => "f", component: () => <p class="fast">fast</p> });
  const slow = defineRoute("/slow", {
    id: "slow",
    loader: () => new Promise((resolve) => { waiting.push(() => resolve("s")); }),
    pending: () => <p class="pending">loading slow</p>,
    component: () => <p class="slow">slow</p>,
  });
  const cached = defineRoute("/cached", {
    id: "cached",
    loader: () => hold(),
    pending: () => <p class="pending">loading cached</p>,
    component: () => <p class="cached">cached</p>,
  });
  // A route that sets its own delay: immediate (0) and 250 ms, against the router's 1000.
  const instant = defineRoute("/instant", {
    id: "instant",
    pendingMs: 0,
    loader: () => new Promise((resolve) => { waiting.push(() => resolve("i")); }),
    pending: () => <p class="pending">loading instant</p>,
    component: () => <p class="instant">instant</p>,
  });
  const tuned = defineRoute("/tuned", {
    id: "tuned",
    pendingMs: 250,
    loader: () => new Promise((resolve) => { waiting.push(() => resolve("t")); }),
    pending: () => <p class="pending">loading tuned</p>,
    component: () => <p class="tuned">tuned</p>,
  });
  // A group sets 100 ms; its child sets nothing and inherits it.
  const grouped = defineRoute("/group", {
    id: "group",
    pendingMs: 100,
    pending: () => <p class="pending">loading group</p>,
    children: [
      defineRoute("/child", {
        id: "group-child",
        loader: () => new Promise((resolve) => { waiting.push(() => resolve("g")); }),
        component: () => <p class="child">child</p>,
      }),
    ],
  });
  const shell = defineRoute("", {
    id: "shell",
    component: () => <main class="shell"><Outlet /></main>,
    pending: () => <p class="shell-pending">shell pending</p>,
    children: [fast, slow, cached, instant, tuned, grouped],
  });

  export function start(host, win, clock, options) {
    const router = createRouter({ features: everyFeature(), routes: [shell], window: win, clock, ...options });
    render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return router;
  }
`;

async function app(): Promise<PendingModule> {
  return load<PendingModule>(APP);
}

describe("pending UI: timing", () => {
  it("[PEND-01 I-L7] a fast navigation never shows the pending UI", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    await router.navigate("/fast");
    clock.advance(5000);
    await settle();
    expect(root.querySelector(".pending")).toBeNull();
    router.dispose();
  });

  it("[PEND-02 I-L7] a slow navigation shows the pending UI only after pendingMs", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const win = new RouterTestWindow("/fast");
    const router = mod.start(root, win, clock, {});
    await settle();
    void router.navigate("/slow");
    await settle();
    clock.advance(999);
    await settle();
    expect(root.querySelector(".pending")).toBeNull();
    clock.advance(1);
    await settle();
    expect(root.querySelector(".pending")?.textContent).toBe("loading slow");
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-03 I-L7] the previous page stays on screen until the pending UI shows", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/slow");
    await settle();
    clock.advance(500);
    await settle();
    expect(root.querySelector(".fast")?.textContent).toBe("fast");
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-04 I-L7] once shown, the pending UI stays for at least pendingMinMs", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/slow");
    await settle();
    clock.advance(1000);
    await settle();
    mod.release();
    await settle();
    expect(root.querySelector(".pending")).not.toBeNull();
    clock.advance(499);
    await settle();
    expect(root.querySelector(".pending")).not.toBeNull();
    clock.advance(1);
    await settle();
    expect(root.querySelector(".pending")).toBeNull();
    expect(root.querySelector(".slow")?.textContent).toBe("slow");
    router.dispose();
  });

  it("[PEND-05 I-L7] a custom pendingMs moves the threshold", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, { pendingMs: 200 });
    await settle();
    void router.navigate("/slow");
    await settle();
    clock.advance(200);
    await settle();
    expect(root.querySelector(".pending")).not.toBeNull();
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-06 I-L7] the navigator's pending flag follows the same threshold", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/slow");
    await settle();
    clock.advance(999);
    expect(router.state.pending()).toBe(false);
    clock.advance(1);
    expect(router.state.pending()).toBe(true);
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-07 I-L7] a navigation that finishes before pendingMs never raises the pending flag", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    await router.navigate("/fast");
    clock.advance(2000);
    expect(router.state.pending()).toBe(false);
    router.dispose();
  });

  it("[PEND-08 I-M2] dispose cancels the pending timer", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/slow");
    await settle();
    expect(clock.pendingTimers).toBeGreaterThan(0);
    router.dispose();
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("pending UI: what is shown", () => {
  it("[PEND-10 I-L7] the pending UI is the target route's pending component", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/slow");
    await settle();
    clock.advance(1000);
    await settle();
    expect(root.querySelector(".pending")?.textContent).toBe("loading slow");
    expect(root.querySelector(".shell")).not.toBeNull();
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-11 I-L7] a navigation whose data is cached shows no pending UI, even when the refresh is slow", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    await router.navigate("/cached");
    await settle();
    expect(root.querySelector(".cached")?.textContent).toBe("cached");
    await router.navigate("/fast");
    await settle();
    mod.holdNext();
    void router.navigate("/cached");
    await settle();
    clock.advance(3000);
    await settle();
    expect(root.querySelector(".pending")).toBeNull();
    expect(root.querySelector(".fast")?.textContent).toBe("fast");
    mod.release();
    await settle();
    expect(root.querySelector(".cached")?.textContent).toBe("cached");
    router.dispose();
  });

  it("[PEND-12 I-L7] a route without a pending component keeps the previous page", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    await router.navigate("/fast");
    clock.advance(5000);
    await settle();
    expect(root.querySelector(".fast")?.textContent).toBe("fast");
    router.dispose();
  });
});

describe("pending UI: per-route and immediate delays", () => {
  it("[PEND-10] router pendingMs: 0 shows the skeleton at once, with no clock advance", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, { pendingMs: 0 });
    await settle();
    void router.navigate("/slow");
    await settle();
    expect(root.querySelector(".pending")?.textContent).toBe("loading slow");
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-11] a route's pendingMs: 0 shows its skeleton at once, while other routes keep the router's delay", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/instant");
    await settle();
    expect(root.querySelector(".pending")?.textContent).toBe("loading instant");
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-12] a route's pendingMs (250) overrides the router's 1000: not at 249, shown at 250", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/tuned");
    await settle();
    clock.advance(249);
    await settle();
    expect(root.querySelector(".pending")).toBeNull();
    clock.advance(1);
    await settle();
    expect(root.querySelector(".pending")?.textContent).toBe("loading tuned");
    mod.release();
    await settle();
    router.dispose();
  });

  it("[PEND-13] a child route with no pendingMs inherits its group's delay (100), not the router's", async () => {
    const mod = await app();
    const root = host();
    const clock = createFakeClock(0);
    const router = mod.start(root, new RouterTestWindow("/fast"), clock, {});
    await settle();
    void router.navigate("/group/child");
    await settle();
    clock.advance(99);
    await settle();
    expect(root.querySelector(".pending")).toBeNull();
    clock.advance(1);
    await settle();
    expect(root.querySelector(".pending")?.textContent).toBe("loading group");
    mod.release();
    await settle();
    router.dispose();
  });
});
