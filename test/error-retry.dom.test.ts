import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

interface RetryRouter {
  navigate(to: string): Promise<unknown>;
  dispose(): void;
}

interface RetryModule {
  start(host: HTMLElement, win: RouterTestWindow, clock: unknown): RetryRouter;
  calls: { flaky: number; renders: number; always: number; parent: number; child: number };
}

// `flaky` fails its first load and succeeds after a retry; `renders` throws on its first render only (its data
// is fine); `always` keeps failing; `parent` and `child` count their own loads, so a retry of the child shows
// that the page's loaders run again (a navigation's reload runs every loader on screen).
const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet, useLoaderData } from "@router";
  import { errorBoundaries } from "@router/errors";
  import { loaderCache } from "@router/loaders";
  import { render } from "@shadow-js/web";

  export const calls = { flaky: 0, renders: 0, always: 0, parent: 0, child: 0 };

  const flaky = defineRoute("/flaky", {
    id: "flaky",
    loader: () => {
      calls.flaky += 1;
      if (calls.flaky === 1) throw new Error("first load failed");
      return "fresh data";
    },
    component: () => <p class="data">{useLoaderData()}</p>,
    error: ({ error, retry }) => <button class="retry" onClick={() => retry()}>retry: {error.message}</button>,
  });

  const renders = defineRoute("/renders", {
    id: "renders",
    component: () => {
      calls.renders += 1;
      if (calls.renders === 1) throw new Error("render failed once");
      return <p class="rendered">rendered</p>;
    },
    error: ({ error, reset }) => <button class="reset" onClick={() => reset()}>reset: {error.message}</button>,
  });

  const always = defineRoute("/always", {
    id: "always",
    loader: () => {
      calls.always += 1;
      throw new Error("still down");
    },
    component: () => <p>never</p>,
    error: ({ error, retry }) => <button class="retry" onClick={() => retry()}>retry: {error.message}</button>,
  });

  const nested = defineRoute("/parent", {
    id: "parent",
    loader: () => {
      calls.parent += 1;
      return "parent data";
    },
    component: () => <main><Outlet /></main>,
    children: [
      defineRoute("/child", {
        id: "child",
        loader: () => {
          calls.child += 1;
          if (calls.child === 1) throw new Error("child load failed");
          return "child data";
        },
        component: () => <p class="child">{useLoaderData()}</p>,
        error: ({ error, retry }) => <button class="retry" onClick={() => retry()}>retry: {error.message}</button>,
      }),
    ],
  });

  export function start(host, win, clock) {
    const router = createRouter({
      features: [errorBoundaries(), loaderCache()],
      routes: [flaky, renders, always, nested],
      window: win,
      clock,
    });
    const stop = render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    const disposeRouter = router.dispose;
    router.dispose = () => { disposeRouter(); stop(); };
    return router;
  }
`;

/** Lets a retry's revalidation finish (it is a navigation under the hood). */
async function drain(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await settle();
}

async function app(): Promise<RetryModule> {
  return load<RetryModule>(APP);
}

describe("route error props: retry and reset", () => {
  it("[ERR-RETRY-01] retry revalidates the route's loader and rebuilds the route with the new data", async () => {
    const mod = await app();
    const router = mod.start(host(), new RouterTestWindow("/flaky"), createFakeClock(0));
    await settle();
    expect(document.querySelector(".retry")?.textContent).toContain("first load failed");
    (document.querySelector(".retry") as HTMLButtonElement).click();
    await drain();
    expect(mod.calls.flaky).toBe(2);
    expect(document.querySelector(".retry")).toBeNull();
    expect(document.querySelector(".data")?.textContent).toBe("fresh data");
    router.dispose();
  });

  it("[ERR-RETRY-02] reset rebuilds a route whose render failed, without loading its data again", async () => {
    const mod = await app();
    const router = mod.start(host(), new RouterTestWindow("/renders"), createFakeClock(0));
    await settle();
    expect(document.querySelector(".reset")?.textContent).toContain("render failed once");
    (document.querySelector(".reset") as HTMLButtonElement).click();
    await drain();
    expect(mod.calls.renders).toBe(2);
    expect(document.querySelector(".reset")).toBeNull();
    expect(document.querySelector(".rendered")?.textContent).toBe("rendered");
    router.dispose();
  });

  it("[ERR-RETRY-03] a retry whose load fails again shows the error again and does not throw out of the router", async () => {
    const mod = await app();
    const router = mod.start(host(), new RouterTestWindow("/always"), createFakeClock(0));
    await settle();
    (document.querySelector(".retry") as HTMLButtonElement).click();
    await drain();
    expect(mod.calls.always).toBe(2);
    expect(document.querySelector(".retry")?.textContent).toContain("still down");
    router.dispose();
  });

  it("[ERR-RETRY-04] retry revalidates the loaders on the page, as invalidate() does: the parent's loader runs again with the child's", async () => {
    const mod = await app();
    const router = mod.start(host(), new RouterTestWindow("/parent/child"), createFakeClock(0));
    await settle();
    expect(mod.calls.parent).toBe(1);
    (document.querySelector(".retry") as HTMLButtonElement).click();
    await drain();
    expect(mod.calls.child).toBe(2);
    expect(mod.calls.parent).toBe(2);
    expect(document.querySelector(".child")?.textContent).toBe("child data");
    router.dispose();
  });
});
