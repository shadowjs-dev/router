import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

/**
 * A window whose animation frames run when a test says so. A view that mounts after the commit (a lazily
 * loaded route, a Suspense boundary) is modeled by the component registering its element on a later frame.
 */
class LandingWindow extends RouterTestWindow {
  readonly frames: Array<() => void> = [];
  readonly intoView: string[] = [];

  requestAnimationFrame(run: () => void): number {
    this.frames.push(run);
    return this.frames.length;
  }

  /** Runs the frames queued so far, and the ones they queue, `count` times at most. */
  runFrames(count: number): void {
    for (let at = 0; at < count; at += 1) {
      const batch = this.frames.splice(0);
      if (batch.length === 0) return;
      for (const run of batch) run();
    }
  }

  /** Makes an element with this id exist in the document of the window, and records its scroll into view. */
  mountElement(id: string): void {
    this.elements.set(id, {
      scrollIntoView: (): void => {
        this.intoView.push(id);
      },
    });
  }
}

const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
  import { scrollRestoration } from "@router/scroll";
  import { render } from "@shadow-js/web";
  let win;
  export const home = defineRoute("/a", {
    id: "a",
    component: () => <main><h1>Home</h1></main>,
  });
  // The element of #intro is on the page at commit.
  export const eager = defineRoute("/eager", {
    id: "eager",
    component: () => { win.mountElement("intro"); return <main><h1>Eager</h1></main>; },
  });
  // The element of #late mounts two frames after the commit, as a lazily loaded view does.
  export const late = defineRoute("/late", {
    id: "late",
    component: () => {
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => win.mountElement("late")));
      return <main><h1>Late</h1></main>;
    },
  });
  // The element never mounts.
  export const missing = defineRoute("/missing", {
    id: "missing",
    component: () => <main><h1>Missing</h1></main>,
  });
  export function start(host, window, clock) {
    win = window;
    const router = createRouter({
      features: [scrollRestoration()],
      routes: [home, eager, late, missing],
      window,
      clock,
    });
    render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return router;
  }
`;

interface LandingRouter {
  navigate(to: string): Promise<unknown>;
  dispose(): void;
}

interface LandingModule {
  start(host: HTMLElement, win: LandingWindow, clock: unknown): LandingRouter;
}

/** A router rendered into the document, on a window whose frames the test runs. */
async function mounted(url: string): Promise<{ router: LandingRouter; win: LandingWindow }> {
  const mod = await load<LandingModule>(APP);
  const win = new LandingWindow(url);
  const router = mod.start(host(), win, createFakeClock(0));
  await settle();
  return { router, win };
}

describe("scroll landing on a hash after a push", () => {
  it("[SCR-30 I-A5] a push to a hash scrolls to an element that is on the page at commit", async () => {
    const { router, win } = await mounted("/a");
    await router.navigate("/eager#intro");
    await settle();
    expect(win.intoView).toEqual(["intro"]);
    expect(win.scrolls).toEqual([]);
    router.dispose();
  });

  it("[SCR-31 I-A5] a push to a hash whose element mounts after the commit is scrolled to once it exists", async () => {
    const { router, win } = await mounted("/a");
    await router.navigate("/late#late");
    await settle();
    expect(win.intoView).toEqual([]);
    win.runFrames(4);
    await settle();
    expect(win.intoView).toEqual(["late"]);
    expect(win.scrolls).toEqual([]);
    router.dispose();
  });

  it("[SCR-32 I-A5] a hash that never mounts falls back to the top of the new page, within a bounded number of frames", async () => {
    const { router, win } = await mounted("/a");
    await router.navigate("/missing#nowhere");
    await settle();
    win.runFrames(200);
    await settle();
    expect(win.intoView).toEqual([]);
    expect(win.scrolls.at(-1)).toEqual([0, 0]);
    expect(win.frames).toEqual([]);
    router.dispose();
  });

  it("[SCR-33 I-A5] a same-page hash change to a missing element does not retry and does not scroll to the top", async () => {
    const { router, win } = await mounted("/missing");
    await router.navigate("/missing#nowhere");
    await settle();
    win.runFrames(200);
    await settle();
    expect(win.scrolls).toEqual([]);
    expect(win.frames).toEqual([]);
    router.dispose();
  });

  it("[SCR-34 I-A5] a user scroll while a hash target is still mounting cancels the landing", async () => {
    const { router, win } = await mounted("/a");
    await router.navigate("/late#late");
    await settle();
    win.dispatch("wheel");
    win.runFrames(4);
    await settle();
    expect(win.intoView).toEqual([]);
    expect(win.scrolls).toEqual([]);
    router.dispose();
  });
});
