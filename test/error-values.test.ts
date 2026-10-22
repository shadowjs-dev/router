import { describe, expect, it } from "vitest";
import { loaderCache } from "../src/features/loaders";
import { createMemoryHistory, createRouter, defineRoute } from "../src/index";
import { hostileThrown } from "./support/hostile-thrown";

/**
 * A loader that throws any hostile value: the router keeps the value as thrown, and its dehydrated data (what the
 * server sends to the page as JSON) stays serializable. A cycle, a getter or a toString in the value must not turn
 * into a TypeError of the router's own.
 */
describe("hostile thrown values in the router error path", () => {
  for (const [name, value] of hostileThrown()) {
    it(`[ERR-R1] ${name}: a failing loader keeps the value as the error of the router`, async () => {
      const router = createRouter({
        routes: [
          defineRoute("/", {
            loader: () => {
              throw value;
            },
            component: () => "home",
          }),
        ],
        history: createMemoryHistory({ initialEntries: ["/"] }),
        features: [loaderCache()],
      });
      try {
        await router.ready();
        // A loader failure is kept on the match it belongs to (the route's error UI reads it from there).
        const data: unknown = router.state.matches()[0]?.loaderData;
        expect(
          typeof data === "object" && data !== null && "error" in data && data.error === value,
        ).toBe(true);
      } finally {
        router.dispose();
      }
    });

    it(`[ERR-R2] ${name}: the dehydrated failure serializes as JSON`, async () => {
      const router = createRouter({
        routes: [
          defineRoute("/", {
            loader: () => {
              throw value;
            },
            component: () => "home",
          }),
        ],
        history: createMemoryHistory({ initialEntries: ["/"] }),
        features: [loaderCache()],
      });
      try {
        await router.ready();
        const data = router.dehydrate();
        expect(() => JSON.stringify(data)).not.toThrow();
      } finally {
        router.dispose();
      }
    });
  }

  it("[ERR-R3] a digest that is not a string is left out of the dehydrated data (it would not serialize)", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const digest of [cyclic, 42n, { nested: true }]) {
      const failure = Object.assign(new Error("with digest"), { digest });
      const router = createRouter({
        routes: [
          defineRoute("/", {
            loader: () => {
              throw failure;
            },
            component: () => "home",
          }),
        ],
        history: createMemoryHistory({ initialEntries: ["/"] }),
        features: [loaderCache()],
      });
      try {
        await router.ready();
        const json = JSON.stringify(router.dehydrate());
        expect(json).toContain("with digest");
        expect(json).not.toContain("self");
      } finally {
        router.dispose();
      }
    }
  });
});
