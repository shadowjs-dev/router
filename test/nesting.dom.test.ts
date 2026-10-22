import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

interface NestingModule {
  start(
    host: HTMLElement,
    deps: { history: unknown; window: unknown; clock: unknown },
  ): { router: { navigate(to: string): Promise<unknown>; dispose(): void } };
  counts: { created: number; disposed: number; leafRuns: number };
  paramsRuns: { page: number; tab: number };
}

const SOURCE = `
  import { createRouter, defineRoute, RouterProvider, Outlet, A, useParams, useSearch, useLoaderData, createMemoryHistory } from "@router";
  import { render, onCleanup } from "@shadow-js/web";
  import { onCleanup as cleanup } from "@shadow-js/core";

  export const counts = { created: 0, disposed: 0, leafRuns: 0 };

  function layout(name, depthKey) {
    return function Layout() {
      counts.created += 1;
      cleanup(() => { counts.disposed += 1; });
      const params = useParams();
      return <div class={"layer-" + name}>{name}:{params[depthKey]}<Outlet /></div>;
    };
  }

  const leaf = defineRoute("/e/:p5", {
    id: "leaf",
    validateSearch: (search) => ({ q: String(search.q ?? "none") }),
    loader: ({ params, search }) => ({ label: "leaf-" + params.p5 + "-" + search.q }),
    component: function Leaf() {
      counts.leafRuns += 1;
      const params = useParams();
      const search = useSearch();
      const data = useLoaderData();
      return <p class="leaf">{params.p5}|{search.q}|{data()?.label}</p>;
    },
  });
  const l4 = defineRoute("/d/:p4", { id: "l4", component: layout("L4", "p4"), children: [leaf] });
  const l3 = defineRoute("/c/:p3", { id: "l3", component: layout("L3", "p3"), children: [l4] });
  const l2 = defineRoute("/b/:p2", { id: "l2", component: layout("L2", "p2"), children: [l3] });
  const l1 = defineRoute("/a/:p1", { id: "l1", component: layout("L1", "p1"), children: [l2] });
  const other = defineRoute("/other", { id: "other", component: () => <p class="other">other</p> });

  export function start(host, deps) {
    const router = createRouter({ features: everyFeature(), routes: [l1, other], history: deps.history, window: deps.window, clock: deps.clock });
    render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return { router };
  }
`;

describe("nested layouts: five levels", () => {
  it("[NEST-01 I-M4] renders five layouts with their params and the leaf with search and loader data", async () => {
    const mod = await load<NestingModule>(SOURCE);
    const root = host();
    const win = new RouterTestWindow("/a/1/b/2/c/3/d/4/e/5?q=hi");
    const { router } = mod.start(root, {
      history: undefined,
      window: win,
      clock: createFakeClock(0),
    });
    await settle();
    expect(root.textContent).toBe("L1:1L2:2L3:3L4:4" + "5|hi|leaf-5-hi");
    expect(root.querySelectorAll(".leaf")).toHaveLength(1);
    router.dispose();
  });

  it("[NEST-02 I-M3] a navigation that keeps every route id keeps the layouts (no remount)", async () => {
    const mod = await load<NestingModule>(SOURCE);
    const root = host();
    const win = new RouterTestWindow("/a/1/b/2/c/3/d/4/e/5");
    const { router } = mod.start(root, {
      history: undefined,
      window: win,
      clock: createFakeClock(0),
    });
    await settle();
    expect(mod.counts.created).toBe(4);
    await router.navigate("/a/9/b/8/c/7/d/6/e/5");
    await settle();
    expect(mod.counts.created).toBe(4);
    expect(mod.counts.disposed).toBe(0);
    expect(root.textContent).toBe("L1:9L2:8L3:7L4:6" + "5|none|leaf-5-none");
    router.dispose();
  });

  it("[NEST-03 I-M3] changing only the leaf's param updates the leaf without rerunning the layouts", async () => {
    const mod = await load<NestingModule>(SOURCE);
    const root = host();
    const win = new RouterTestWindow("/a/1/b/2/c/3/d/4/e/5");
    const { router } = mod.start(root, {
      history: undefined,
      window: win,
      clock: createFakeClock(0),
    });
    await settle();
    const leafBefore = root.querySelector(".leaf");
    await router.navigate("/a/1/b/2/c/3/d/4/e/6");
    await settle();
    expect(root.querySelector(".leaf")).toBe(leafBefore);
    expect(root.textContent).toContain("6|none|leaf-6-none");
    expect(mod.counts.created).toBe(4);
    router.dispose();
  });

  it("[NEST-04 I-M1] leaving the route disposes its layout and everything it created", async () => {
    const mod = await load<NestingModule>(SOURCE);
    const root = host();
    const win = new RouterTestWindow("/a/1/b/2/c/3/d/4/e/5");
    const { router } = mod.start(root, {
      history: undefined,
      window: win,
      clock: createFakeClock(0),
    });
    await settle();
    await router.navigate("/other");
    await settle();
    expect(mod.counts.disposed).toBe(4);
    expect(root.textContent).toBe("other");
    router.dispose();
  });

  it("[NEST-05 I-M4] the router adds no wrapper element and no comment node around the outlets", async () => {
    const mod = await load<NestingModule>(SOURCE);
    const root = host();
    const win = new RouterTestWindow("/a/1/b/2/c/3/d/4/e/5");
    const { router } = mod.start(root, {
      history: undefined,
      window: win,
      clock: createFakeClock(0),
    });
    await settle();
    expect(root.firstElementChild?.className).toBe("layer-L1");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    expect(walker.nextNode()).toBeNull();
    router.dispose();
  });

  it("[NEST-06 I-M3] navigating from the leaf to a sibling leaf keeps the common layouts", async () => {
    const mod = await load<NestingModule>(SOURCE);
    const root = host();
    const win = new RouterTestWindow("/a/1/b/2/c/3/d/4/e/5");
    const { router } = mod.start(root, {
      history: undefined,
      window: win,
      clock: createFakeClock(0),
    });
    await settle();
    await router.navigate("/other");
    await settle();
    await router.navigate("/a/1/b/2/c/3/d/4/e/5");
    await settle();
    expect(mod.counts.created).toBe(8);
    expect(root.textContent).toBe("L1:1L2:2L3:3L4:4" + "5|none|leaf-5-none");
    router.dispose();
  });

  it("[NEST-07 I-M1] a thousand leaf navigations keep the live layout count constant", async () => {
    const mod = await load<NestingModule>(SOURCE);
    const root = host();
    const win = new RouterTestWindow("/a/1/b/2/c/3/d/4/e/0");
    const { router } = mod.start(root, {
      history: undefined,
      window: win,
      clock: createFakeClock(0),
    });
    await settle();
    for (let n = 1; n <= 1000; n += 1) {
      await router.navigate(`/a/1/b/2/c/3/d/4/e/${String(n)}`);
    }
    await settle();
    expect(mod.counts.created - mod.counts.disposed).toBe(4);
    router.dispose();
  });
});
