import { describe, expect, it } from "vitest";
import { defineRoute } from "../src/index";
import { deferred } from "./support/deferred";
import { rig, settle } from "./support/rig";

/**
 * A route's UI code is a separate chunk (`lazy`). The router asks for it as soon as the loaders start, so the chunk and the
 * data arrive together instead of one after the other: a navigation costs the slower of the two, not their sum.
 */

/** A component shaped like `lazy()`: calling it renders, `preload()` starts the chunk. */
function lazyComponent(log: string[], name: string) {
  const component = Object.assign(() => null, {
    preload: () => {
      log.push(`chunk:${name}`);
      return Promise.resolve(component);
    },
  });
  return component;
}

describe("the router asks for the UI chunks while the loaders run", () => {
  it("[WARM-01] a navigation starts the chunk of every matched route next to its loader", async () => {
    const log: string[] = [];
    const data = deferred<string>();
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/shop", {
        component: lazyComponent(log, "layout"),
        children: [
          defineRoute("/items", {
            component: lazyComponent(log, "items"),
            loader: () => {
              log.push("loader:items");
              return data.promise;
            },
          }),
        ],
      }),
    ]);
    await r.router.ready();
    void r.router.navigate("/shop/items");
    await settle();
    // Both chunks were requested while the loader is still waiting for its data.
    expect(log).toContain("chunk:layout");
    expect(log).toContain("chunk:items");
    expect(log).toContain("loader:items");
    data.resolve("rows");
    await settle();
    r.router.dispose();
  });

  it("[WARM-02] a preload does not fetch chunks (the prefetch feature decides that), and a route without lazy code is fine", async () => {
    const log: string[] = [];
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/lazy", { component: lazyComponent(log, "lazy") }),
      defineRoute("/plain", { component: () => null }),
    ]);
    await r.router.ready();
    await r.router.preload("/lazy");
    expect(log).toEqual([]);
    await r.router.navigate("/plain");
    expect(r.router.state.location()?.pathname).toBe("/plain");
    r.router.dispose();
  });

  it("[WARM-03] a chunk that fails to load does not fail the navigation: the render reports it", async () => {
    const failing = Object.assign(() => null, {
      preload: () => Promise.reject(new Error("chunk 404")),
    });
    const r = rig([defineRoute("/", {}), defineRoute("/broken", { component: failing })]);
    await r.router.ready();
    const outcome = await r.router.navigate("/broken");
    expect(outcome.kind).toBe("success");
    r.router.dispose();
  });
});
