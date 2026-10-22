import { describe, expect, it, vi } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

interface ErrorsModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    clock: unknown,
    errors: unknown[],
  ): { navigate(to: string): Promise<unknown>; dispose(): void };
  events: string[];
}

/**
 * A small app with error, not-found and redirect cases. `events` records what ran, in order, so a
 * test can assert on the sequence rather than on timing.
 */
const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet, A, useLoaderData, useParams, redirect, notFound } from "@router";
  import { render } from "@shadow-js/web";

  export const events = [];

  const boom = defineRoute("/boom", {
    id: "boom",
    component: () => { throw new Error("render exploded"); },
    error: ({ error, reset }) => {
      events.push("error:" + error.message);
      return <button class="retry" onClick={() => reset()}>retry</button>;
    },
  });
  const loaderBoom = defineRoute("/loader-boom/:id", {
    id: "loader-boom",
    loader: ({ params }) => { throw new Error("db down for " + params.id); },
    component: () => <p>never</p>,
    error: ({ error }) => <p class="failed">{error.message}</p>,
  });
  const missing = defineRoute("/missing", {
    id: "missing",
    loader: () => { throw notFound(); },
    component: () => <p>never</p>,
    notFound: () => <p class="nf">no such page</p>,
  });
  const bare = defineRoute("/bare-nf", {
    id: "bare-nf",
    loader: () => { throw notFound(); },
    component: () => <p>never</p>,
  });
  const home = defineRoute("/", { id: "home", component: () => <p class="home">home</p> });
  const plain = defineRoute("/plain", { id: "plain", component: () => <p class="plain">plain</p> });

  const guarded = defineRoute("/guarded", {
    id: "guarded",
    beforeLoad: () => { throw redirect("/plain"); },
    component: () => <p>never</p>,
  });

  const outer = defineRoute("", {
    id: "outer",
    component: () => <main class="outer"><Outlet /></main>,
    error: () => <p class="outer-error">outer caught</p>,
    notFound: () => <p class="outer-nf">outer not found</p>,
    children: [
      defineRoute("/outer-child", {
        id: "outer-child",
        component: () => { throw new Error("child broke"); },
      }),
      defineRoute("/inner", {
        id: "inner",
        component: () => <p class="inner">inner</p>,
        children: [],
      }),
    ],
  });

  const nested = defineRoute("", {
    id: "nested",
    component: () => <section class="nested"><Outlet /></section>,
    notFound: () => <p class="nested-nf">nested not found</p>,
    children: [
      defineRoute("/n/:id", {
        id: "n-leaf",
        loader: ({ params }) => { if (params.id === "gone") throw notFound(); return params.id; },
        component: () => <p class="leaf">leaf</p>,
      }),
    ],
  });

  const shellData = defineRoute("", {
    id: "shell-data",
    loader: () => ({ viewer: "ada" }),
    component: function Shell() {
      const data = useLoaderData();
      return <section class="shell"><header class="viewer">{data()?.viewer}</header><Outlet /></section>;
    },
    notFound: () => <p class="shell-nf">shell not found</p>,
    children: [
      defineRoute("/w/:id", {
        id: "shell-project",
        loader: ({ params }) => { if (params.id === "nope") throw notFound(); return params.id; },
        component: () => <p class="project">project</p>,
      }),
    ],
  });

  const guardedLayout = defineRoute("", {
    id: "guarded-layout",
    loader: () => { throw notFound(); },
    component: () => <section class="guarded"><Outlet /></section>,
    notFound: () => <p class="guarded-nf">guarded not found</p>,
    children: [
      defineRoute("/guarded-child", {
        id: "guarded-child",
        component: () => <p class="guarded-child">child</p>,
      }),
    ],
  });

  export function start(host, win, clock, errors) {
    const router = createRouter({ features: everyFeature(),
      routes: [boom, loaderBoom, missing, bare, home, plain, guarded, outer, nested, shellData, guardedLayout],
      window: win,
      clock,
      onError: (error) => errors.push(error),
    });
    render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return router;
  }
`;

async function app(): Promise<ErrorsModule> {
  return load<ErrorsModule>(APP);
}

describe("route error boundaries", () => {
  it("[ERR-01 I-L8] a throwing component shows its route's error component with the error", async () => {
    const mod = await app();
    const root = host();
    const errors: unknown[] = [];
    const router = mod.start(root, new RouterTestWindow("/boom"), createFakeClock(0), errors);
    await settle();
    expect(root.querySelector(".retry")?.textContent).toBe("retry");
    expect(mod.events).toEqual(["error:render exploded"]);
    expect(errors).toEqual([]);
    router.dispose();
  });

  it("[ERR-02 I-L8] the error component's reset rebuilds the route", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/boom"), createFakeClock(0), []);
    await settle();
    (root.querySelector(".retry") as HTMLElement).click();
    await settle();
    expect(mod.events).toEqual(["error:render exploded", "error:render exploded"]);
    router.dispose();
  });

  it("[ERR-03 I-L9] a loader failure shows the error component of its route", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/loader-boom/9"), createFakeClock(0), []);
    await settle();
    expect(root.querySelector(".failed")?.textContent).toBe("db down for 9");
    router.dispose();
  });

  it("[ERR-04 I-L8] navigating away resets the boundary", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/boom"), createFakeClock(0), []);
    await settle();
    await router.navigate("/plain");
    await settle();
    expect(root.textContent).toBe("plain");
    router.dispose();
  });

  it("[ERR-05 I-L8] navigating to the same route with other params resets the boundary", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/loader-boom/1"), createFakeClock(0), []);
    await settle();
    expect(root.querySelector(".failed")?.textContent).toBe("db down for 1");
    await router.navigate("/loader-boom/2");
    await settle();
    expect(root.querySelector(".failed")?.textContent).toBe("db down for 2");
    router.dispose();
  });

  it("[ERR-06 I-L8] a child without a boundary hands its error to the parent, which replaces its content", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/outer-child"), createFakeClock(0), []);
    await settle();
    expect(root.querySelector(".outer")).toBeNull();
    expect(root.querySelector(".outer-error")?.textContent).toBe("outer caught");
    router.dispose();
  });

  it("[ERR-07 I-L8] a sibling of a failing route keeps rendering after the reset", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/inner"), createFakeClock(0), []);
    await settle();
    expect(root.querySelector(".inner")?.textContent).toBe("inner");
    router.dispose();
  });

  it("[ERR-08 I-L9] a throw with no boundary above it is reported through the router's onError", async () => {
    const bad = await load<{
      mount(
        host: HTMLElement,
        win: RouterTestWindow,
        errors: unknown[],
      ): { navigate(to: string): Promise<unknown>; dispose(): void };
    }>(`
      import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
      import { render } from "@shadow-js/web";
      const crash = defineRoute("/crash", { component: () => { throw new Error("no boundary"); } });
      const calm = defineRoute("/calm", { component: () => "calm" });
      export function mount(host, win, errors) {
        const router = createRouter({ features: everyFeature(), routes: [crash, calm], window: win, onError: (error) => errors.push(error) });
        render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
        return router;
      }
    `);
    const root = host();
    const errors: unknown[] = [];
    const router = bad.mount(root, new RouterTestWindow("/calm"), errors);
    await settle();
    expect(root.textContent).toBe("calm");
    await router.navigate("/crash");
    await settle();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("no boundary");
    router.dispose();
  });

  it("[ERR-09 I-N3] a redirect from beforeLoad is followed and nothing is logged as an error", async () => {
    const mod = await app();
    const root = host();
    const win = new RouterTestWindow("/guarded");
    const router = mod.start(root, win, createFakeClock(0), []);
    await settle();
    expect(root.textContent).toBe("plain");
    expect(win.location.pathname).toBe("/plain");
    router.dispose();
  });

  it("[ERR-10 I-L9] control-flow signals are not reported through onError", async () => {
    const mod = await app();
    const root = host();
    const errors: unknown[] = [];
    const router = mod.start(root, new RouterTestWindow("/guarded"), createFakeClock(0), errors);
    await settle();
    await router.navigate("/missing");
    await settle();
    expect(errors).toEqual([]);
    router.dispose();
  });
});

describe("not-found bubbling", () => {
  it("[ERR-20 I-L8] a notFound from a loader renders the nearest notFound component in place of the route", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    await router.navigate("/missing");
    await settle();
    expect(root.querySelector(".nf")?.textContent).toBe("no such page");
    router.dispose();
  });

  it("[ERR-21 I-L8] notFound bubbles to the nearest ancestor with a notFound component", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    await router.navigate("/n/gone");
    await settle();
    expect(root.querySelector(".nested-nf")?.textContent).toBe("nested not found");
    router.dispose();
  });

  it("[ERR-22 I-L8] a notFound on an unmatched path renders the notFound of the first root layout inside that layout and reports the outcome", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    const outcome = await router.navigate("/nowhere/at/all");
    await settle();
    expect(outcome).toMatchObject({ kind: "notFound" });
    expect(root.querySelector(".outer > .outer-nf")?.textContent).toBe("outer not found");
    expect(root.querySelectorAll(".outer-nf")).toHaveLength(1);
    expect(root.querySelector(".nested")).toBeNull();
    router.dispose();
  });

  it("[ERR-24 I-L8] a notFound from a child loader keeps the layout's loader data and shows the layout's notFound in its outlet", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    await router.navigate("/w/nope");
    await settle();
    expect(root.querySelector(".shell > .viewer")?.textContent).toBe("ada");
    expect(root.querySelector(".shell > .shell-nf")?.textContent).toBe("shell not found");
    expect(root.querySelector(".project")).toBeNull();
    router.dispose();
  });

  it("[ERR-25 I-L8] a layout whose own loader throws notFound is replaced by its notFound, since it has no data to show", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    await router.navigate("/guarded-child");
    await settle();
    expect(root.querySelector(".guarded-nf")?.textContent).toBe("guarded not found");
    expect(root.querySelector(".guarded")).toBeNull();
    expect(root.querySelector(".guarded-child")).toBeNull();
    router.dispose();
  });

  it("[ERR-23 I-L8] a notFound component of a layout replaces what is in its outlet, not the layout", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    await router.navigate("/n/gone");
    await settle();
    expect(root.querySelectorAll(".nested-nf")).toHaveLength(1);
    expect(root.querySelector(".nested > .nested-nf")).not.toBeNull();
    expect(root.querySelector(".leaf")).toBeNull();
    router.dispose();
  });

  it("[ERR-23b I-L8] a notFound component of a route without children replaces that route", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    await router.navigate("/missing");
    await settle();
    expect(root.querySelectorAll(".nf")).toHaveLength(1);
    expect(root.textContent).toBe("no such page");
    router.dispose();
  });

  it("[ERR-25 I-L8] an unmatched path renders nothing when no root layout has a notFound component", async () => {
    const mod = await load<ErrorsModule>(`
      import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
      import { render } from "@shadow-js/web";
      const page = defineRoute("/", { id: "home", component: () => <p>home</p> });
      const layout = defineRoute("", { id: "layout", component: () => <main class="chrome"><Outlet /></main>, children: [page] });
      export function start(host, win, clock, errors) {
        const router = createRouter({ features: everyFeature(), routes: [layout], window: win, clock, onError: (error) => errors.push(error) });
        render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
        return router;
      }
    `);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    const outcome = await router.navigate("/nowhere");
    await settle();
    expect(outcome).toMatchObject({ kind: "notFound" });
    expect(root.textContent).toBe("");
    router.dispose();
  });

  it("[ERR-26 I-L8] a pathful top-level route is not a root layout for unmatched paths", async () => {
    const mod = await load<ErrorsModule>(`
      import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
      import { render } from "@shadow-js/web";
      const child = defineRoute("/x", { id: "x", component: () => <p>x</p> });
      const section = defineRoute("/section", { id: "section", component: () => <div class="section"><Outlet /></div>, notFound: () => <p class="nf">nope</p>, children: [child] });
      export function start(host, win, clock, errors) {
        const router = createRouter({ features: everyFeature(), routes: [section], window: win, clock, onError: (error) => errors.push(error) });
        render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
        return router;
      }
    `);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/section/x"), createFakeClock(0), []);
    await settle();
    await router.navigate("/elsewhere");
    await settle();
    expect(root.textContent).toBe("");
    router.dispose();
  });

  it("[ERR-24 I-L8] a notFound with no component anywhere renders nothing", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), []);
    await settle();
    const outcome = await router.navigate("/bare-nf");
    await settle();
    expect(outcome).toMatchObject({ kind: "notFound" });
    expect(root.textContent).toBe("");
    router.dispose();
  });
});

describe("console discipline", () => {
  it("[ERR-30 I-L9] a loader error is not written to the console", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/loader-boom/3"), createFakeClock(0), []);
    await settle();
    expect(vi.mocked(console.error).mock.calls).toEqual([]);
    router.dispose();
  });
});
