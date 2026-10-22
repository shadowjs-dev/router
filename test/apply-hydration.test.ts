import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, defineRoute, type HydrationData } from "../src/index";
import { everyFeature } from "./support/features";

describe("Router.applyHydration (single-flight apply)", () => {
  it("[FLIGHT-R1] seeds the current location's loader data and re-renders it without running the loader again", async () => {
    let runs = 0;
    const news = defineRoute("/news", {
      id: "news",
      loader: () => {
        runs += 1;
        return { n: runs };
      },
    });
    const router = createRouter({
      features: everyFeature(),
      routes: [news],
      history: createMemoryHistory({ initialEntries: ["/news"] }),
    });
    await router.ready();
    expect(runs).toBe(1);
    const data: HydrationData = {
      version: 1,
      matches: [
        {
          id: "news",
          params: {},
          deps: undefined,
          updatedAt: Date.now(),
          value: { n: 42 },
          failed: false,
        },
      ],
    };
    await router.applyHydration(data);
    expect(runs).toBe(1);
    const match = router.state.matches().find((entry) => entry.id === "news");
    expect(match?.loaderData).toEqual({ n: 42 });
    router.dispose();
  });

  it("[FLIGHT-R2] data that is not hydration data is refused, and the page keeps its data", async () => {
    const news = defineRoute("/news", { id: "news", loader: () => ({ n: 1 }) });
    const router = createRouter({
      features: everyFeature(),
      routes: [news],
      history: createMemoryHistory({ initialEntries: ["/news"] }),
    });
    await router.ready();
    const bad = { version: 2, matches: [] } as unknown as HydrationData;
    await expect(router.applyHydration(bad)).rejects.toThrow(TypeError);
    const match = router.state.matches().find((entry) => entry.id === "news");
    expect(match?.loaderData).toEqual({ n: 1 });
    router.dispose();
  });
});
