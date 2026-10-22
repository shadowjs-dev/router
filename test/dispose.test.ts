import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, defineRoute } from "../src/index";

/**
 * Wraps `listen` of a history so the test sees every listener that is still registered. The router
 * subscribes through the history object, so the count is what the router left behind.
 */
function countListeners(history: ReturnType<typeof createMemoryHistory>): () => number {
  let active = 0;
  const listen = history.listen;
  history.listen = (listener) => {
    active += 1;
    const off = listen(listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      active -= 1;
      off();
    };
  };
  return () => active;
}

const routes = [
  defineRoute("/", { component: () => "home" }),
  defineRoute("/about", { component: () => "about" }),
];

describe("router.dispose()", () => {
  it("[RTR-D1] releases every history listener the router registered", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const listeners = countListeners(history);
    const router = createRouter({ routes, history });
    await router.ready();
    expect(listeners()).toBeGreaterThan(0);
    router.dispose();
    expect(listeners()).toBe(0);
  });

  it("[RTR-D2] after dispose a change of the history does not move the router", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({ routes, history });
    await router.ready();
    router.dispose();
    history.push("/about");
    await Promise.resolve();
    await Promise.resolve();
    expect(router.state.location()?.pathname).toBe("/");
  });

  it("[RTR-D3] dispose leaves a history the caller supplied alive (the caller destroys it)", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    let destroyed = 0;
    const destroy = history.destroy;
    history.destroy = () => {
      destroyed += 1;
      destroy();
    };
    const supplied = createRouter({ routes, history });
    supplied.dispose();
    expect(destroyed).toBe(0);
  });

  it("[RTR-D4] dispose is idempotent and a disposed router refuses navigation", async () => {
    const router = createRouter({ routes });
    await router.ready();
    router.dispose();
    router.dispose();
    const outcome = await router.navigate("/about");
    expect(outcome.kind).toBe("canceled");
  });
});
