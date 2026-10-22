import { describe, expect, it } from "vitest";
import { defineRoute } from "../src/index";
import { host } from "./support/app";
import { load } from "./support/compile";
import { deferred } from "./support/deferred";
import { everyFeature, viewTransitions } from "./support/features";
import { type Rig, rig, settle } from "./support/rig";
import { RouterTestWindow } from "./support/router-window";

const ROUTES = (slow?: Promise<string>): ReturnType<typeof defineRoute>[] => [
  defineRoute("/a", {}),
  defineRoute("/b", {}),
  defineRoute("/c", {}),
  defineRoute("/d", {}),
  defineRoute("/slow", { loader: () => slow ?? "done" }),
];

/** A router with view transitions on, in a window that has the API. */
async function transitioning(
  options: { types?: boolean; slow?: Promise<string> } = {},
): Promise<Rig> {
  const r = rig(ROUTES(options.slow), {
    url: "/a",
    features: [...everyFeature(), viewTransitions()],
  });
  r.win.hasViewTransitions = true;
  r.win.hasTransitionTypes = options.types === true;
  await r.router.ready();
  r.win.transitions.splice(0);
  r.win.transitionTypes.splice(0);
  return r;
}

/** The ids of the routes the page shows (the snapshot a transition publishes). */
function onScreen(r: Rig): string[] {
  return r.router.state.matches().map((match) => match.id);
}

describe("view transitions on navigation", () => {
  it("[ROUTER-VT-01] viewTransition: false commits without a transition, and the next navigation transitions again", async () => {
    const r = await transitioning();
    await r.router.navigate("/b", { viewTransition: false });
    expect(r.win.transitions).toEqual([]);
    expect(r.router.state.location()?.pathname).toBe("/b");
    await r.router.navigate("/c");
    expect(r.win.transitions).toEqual(["start"]);
    expect(r.router.state.location()?.pathname).toBe("/c");
    r.router.dispose();
  });

  it("[ROUTER-VT-02] where types are supported, a push is forward, a step back is back and a replace is replace", async () => {
    const r = await transitioning({ types: true });
    await r.router.navigate("/b");
    await r.router.navigate("/c");
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    await r.router.navigate("/d", { replace: true });
    expect(r.win.transitionTypes).toEqual([["forward"], ["forward"], ["back"], ["replace"]]);
    r.router.dispose();
  });

  it("[ROUTER-VT-03] a step forward in history is forward", async () => {
    const r = await transitioning({ types: true });
    await r.router.navigate("/b");
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    r.win.transitionTypes.splice(0);
    r.router.history.go(1);
    r.win.runAllTraversals();
    await settle();
    expect(r.win.transitionTypes).toEqual([["forward"]]);
    r.router.dispose();
  });

  it("[ROUTER-VT-04] without type support the transition starts without types", async () => {
    const r = await transitioning({ types: false });
    await r.router.navigate("/b");
    expect(r.win.transitionTypes).toEqual([undefined]);
    r.router.dispose();
  });

  it("[ROUTER-VT-05] a commit while a transition runs applies at once and starts no second transition", async () => {
    const r = await transitioning();
    r.win.holdTransitions = true;
    await r.router.navigate("/b");
    await r.router.navigate("/c");
    expect(r.win.transitions).toEqual(["start"]);
    expect(r.router.state.location()?.pathname).toBe("/c");
    r.win.finishTransitions();
    await settle();
    await r.router.navigate("/d");
    expect(r.win.transitions).toEqual(["start", "start"]);
    r.router.dispose();
  });

  it("[ROUTER-VT-06] an update the browser runs late is dropped when a newer commit overtook it", async () => {
    const r = await transitioning();
    r.win.holdTransitions = true;
    r.win.deferUpdates = true;
    await r.router.navigate("/b");
    await r.router.navigate("/c");
    expect(onScreen(r)).toEqual(["/c"]);
    const scrolled = r.win.scrolls.length;
    r.win.runDeferredUpdates();
    await settle();
    expect(onScreen(r)).toEqual(["/c"]);
    // The dropped update did not run its after-commit work (the scroll to the top).
    expect(r.win.scrolls.length).toBe(scrolled);
    r.router.dispose();
  });

  it("[ROUTER-VT-07] disposing the router skips the running transition and drops its pending update", async () => {
    const r = await transitioning();
    r.win.holdTransitions = true;
    r.win.deferUpdates = true;
    await r.router.navigate("/b");
    r.router.dispose();
    expect(r.win.skipped).toBe(1);
    const scrolled = r.win.scrolls.length;
    r.win.runDeferredUpdates();
    await settle();
    expect(r.win.scrolls.length).toBe(scrolled);
  });

  it("[ROUTER-VT-08] an opt-out of a navigation that is overtaken by a back step does not leak onto the back step", async () => {
    const slow = deferred<string>();
    const r = await transitioning({ types: true, slow: slow.promise });
    await r.router.navigate("/b");
    r.win.transitions.splice(0);
    r.win.transitionTypes.splice(0);
    void r.router.navigate("/slow", { viewTransition: false });
    await settle();
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    slow.resolve("late");
    await settle();
    expect(onScreen(r)).toEqual(["/a"]);
    expect(r.win.transitionTypes).toEqual([["back"]]);
    r.router.dispose();
  });

  it("[ROUTER-VT-09] a superseded navigation's opt-out does not apply to the navigation that replaced it", async () => {
    const slow = deferred<string>();
    const r = await transitioning({ slow: slow.promise });
    void r.router.navigate("/slow", { viewTransition: false });
    await settle();
    await r.router.navigate("/c");
    expect(r.win.transitions).toEqual(["start"]);
    slow.resolve("late");
    await settle();
    r.router.dispose();
  });
});

describe("view transitions on links", () => {
  it("[ROUTER-VT-10] <A viewTransition={false}> commits without a transition and a plain <A> transitions", async () => {
    const mod = await load<{
      start(host: HTMLElement, win: RouterTestWindow): { dispose(): void };
    }>(`
      import { createRouter, defineRoute, RouterProvider, Outlet, A } from "@router";
      import { viewTransitions } from "@router/transitions";
      import { render } from "@shadow-js/web";
      const home = defineRoute("/", { id: "home", component: () => <p>home</p> });
      const quiet = defineRoute("/quiet", { id: "quiet", component: () => <p>quiet</p> });
      const loud = defineRoute("/loud", { id: "loud", component: () => <p>loud</p> });
      function Page() {
        return <div><A to="/quiet" class="quiet" viewTransition={false}>q</A><A to="/loud" class="loud">l</A><Outlet /></div>;
      }
      const shell = defineRoute("", { id: "shell", component: Page, children: [home, quiet, loud] });
      export function start(host, win) {
        const router = createRouter({ features: [...everyFeature(), viewTransitions()], routes: [shell], window: win });
        render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
        return { dispose: () => router.dispose() };
      }
    `);
    const root = host();
    const win = new RouterTestWindow("/");
    win.hasViewTransitions = true;
    const router = mod.start(root, win);
    await settle();
    win.transitions.splice(0);
    root.querySelector<HTMLAnchorElement>("a.quiet")?.click();
    await settle();
    expect(win.location.pathname).toBe("/quiet");
    expect(win.transitions).toEqual([]);
    root.querySelector<HTMLAnchorElement>("a.loud")?.click();
    await settle();
    expect(win.location.pathname).toBe("/loud");
    expect(win.transitions).toEqual(["start"]);
    router.dispose();
  });
});
