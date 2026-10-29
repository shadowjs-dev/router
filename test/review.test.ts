import { flushSync, useSignal } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { resolveLocation } from "../src/core/history";
import { createLoaderCache } from "../src/core/loader-cache";
import { createNavigator, type NavigationRoute } from "../src/core/navigation";
import { blockers } from "../src/features/blockers";
import { loaderCache } from "../src/features/loaders";
import { createMemoryHistory, createRouter, defineRoute } from "../src/index";
import type { Capabilities } from "../src/internal/capabilities";
import { LoaderFailure } from "../src/internal/failure";
import { createPrefetchQueue } from "../src/internal/prefetch-queue";
import { deferred } from "./support/deferred";
import { createEffect } from "./support/effect";
import { createFakeClock } from "./support/fake-clock";
import { featuresWith } from "./support/features";
import { rig, settle } from "./support/rig";

function cacheRig(
  options: { readonly staleTime?: number; readonly isFailure?: (value: unknown) => boolean } = {},
) {
  const clock = createFakeClock(0);
  const cache = createLoaderCache({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    staleTime: options.staleTime ?? 1_000_000,
    ...(options.isFailure === undefined ? {} : { isFailure: options.isFailure }),
  });
  return { cache, clock };
}

describe("router review: loader cache", () => {
  it("[RTR-REV-1] a loader that failed is not served as fresh data within staleTime", async () => {
    let calls = 0;
    const r = rig(
      [
        defineRoute("/", {}),
        defineRoute("/item", {
          loader: () => {
            calls += 1;
            if (calls === 1) throw new Error("transient");
            return "ok";
          },
        }),
      ],
      { features: featuresWith(loaderCache({ staleTime: 60_000 })) },
    );
    await r.router.ready();
    await r.router.navigate("/item");
    expect(r.router.state.matches()[0]?.loaderData).toBeInstanceOf(LoaderFailure);
    await r.router.navigate("/");
    await r.router.navigate("/item");
    expect(calls).toBe(2);
    expect(r.router.state.matches()[0]?.loaderData).toBe("ok");
    r.router.dispose();
  });

  it("[RTR-REV-1b] the cache refetches an entry its isFailure test marks, on navigate and preload, but keeps it for hydrate", async () => {
    const { cache } = cacheRig({ isFailure: (value) => value === "bad" });
    let runs = 0;
    const request = (intent: "navigate" | "preload" | "hydrate") => ({
      routeId: "r",
      params: {},
      intent,
      staleReload: "background" as const,
      run: () => {
        runs += 1;
        return runs === 1 ? "bad" : "good";
      },
    });
    expect(await cache.load(request("navigate"))).toBe("bad");
    expect(await cache.load(request("hydrate"))).toBe("bad");
    expect(runs).toBe(1);
    expect(cache.peek("r", {})?.stale).toBe(true);
    // A failed entry is never answered from the cache, even for a route that revalidates in the background.
    expect(await cache.load(request("navigate"))).toBe("good");
    expect(runs).toBe(2);
    expect(await cache.load(request("navigate"))).toBe("good");
    expect(runs).toBe(2);
  });

  it("[RTR-REV-2] data loaded by a flight that started before an invalidation is stale when it lands", async () => {
    const { cache } = cacheRig();
    const gate = deferred<string>();
    let runs = 0;
    const request = {
      routeId: "r",
      params: { id: "1" },
      tags: ["posts"],
      intent: "navigate" as const,
      staleReload: "blocking" as const,
      run: () => {
        runs += 1;
        return runs === 1 ? gate.promise : "fresh";
      },
    };
    const first = cache.load(request);
    await settle();
    cache.invalidate({ tag: "posts" });
    gate.resolve("old");
    expect(await first).toBe("old");
    // The mutation that invalidated happened after the old load began, so the next navigation must refetch.
    expect(await cache.load(request)).toBe("fresh");
    expect(runs).toBe(2);
  });

  it("[RTR-REV-2c] a reload after an invalidation does not join the load that began before it", async () => {
    const { cache } = cacheRig();
    const gate = deferred<string>();
    let runs = 0;
    const request = (intent: "navigate" | "reload") => ({
      routeId: "r",
      params: {},
      intent,
      run: () => {
        runs += 1;
        return runs === 1 ? gate.promise : "fresh";
      },
    });
    const first = cache.load(request("navigate"));
    await settle();
    cache.invalidate({});
    expect(await cache.load(request("reload"))).toBe("fresh");
    expect(runs).toBe(2);
    gate.resolve("old");
    expect(await first).toBe("old");
    await settle();
    // The older load answered its own caller but did not overwrite the newer entry.
    expect(cache.peek("r", {})?.value).toBe("fresh");
    expect(cache.peek("r", {})?.stale).toBe(false);
  });

  it("[RTR-REV-2b] an invalidation of another route does not touch a flight", async () => {
    const { cache } = cacheRig();
    const gate = deferred<string>();
    let runs = 0;
    const request = {
      routeId: "r",
      params: {},
      intent: "navigate" as const,
      run: () => {
        runs += 1;
        return gate.promise;
      },
    };
    const first = cache.load(request);
    await settle();
    cache.invalidate({ routeId: "other" });
    gate.resolve("v");
    await first;
    await cache.load(request);
    expect(runs).toBe(1);
  });
});

describe("router review: navigator", () => {
  const routes: NavigationRoute[] = [
    { id: "home", path: "/" },
    { id: "slow", path: "/slow", loader: () => new Promise(() => undefined) },
  ];

  function navigatorRig() {
    const clock = createFakeClock(0);
    const history = createMemoryHistory({ initialEntries: ["/"], scheduleFlush: (run) => run() });
    const cache = createLoaderCache({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const navigator = createNavigator({
      routes,
      history,
      loaderCache: cache,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    return { clock, navigator, cache };
  }

  it("[RTR-REV-3] destroying a navigator with a pending UI leaves no timer behind", async () => {
    const { clock, navigator } = navigatorRig();
    const outcome = navigator.navigate("/slow");
    await settle();
    clock.advance(1000);
    expect(navigator.getSnapshot().pending).toBe(true);
    navigator.destroy();
    expect((await outcome).kind).toBe("canceled");
    await settle();
    expect(clock.pendingTimers).toBe(0);
  });

  it("[RTR-REV-4] a finished preload leaves no listener on the caller's signal", async () => {
    const { navigator } = navigatorRig();
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args: Parameters<typeof add>): void => {
      added += 1;
      add(...args);
    };
    controller.signal.removeEventListener = (...args: Parameters<typeof remove>): void => {
      removed += 1;
      remove(...args);
    };
    await navigator.preload("/", controller.signal);
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

describe("router review: user callbacks run untracked", () => {
  it("[RTR-REV-5] a navigation started inside an effect does not subscribe the effect to what beforeLoad reads", async () => {
    const [flag, setFlag] = useSignal(0);
    let runs = 0;
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routes: [
        defineRoute("/", {}),
        defineRoute("/guarded", {
          beforeLoad: () => {
            flag();
          },
          validateSearch: (search) => {
            flag();
            return search;
          },
        }),
      ],
      features: featuresWith(),
    });
    await router.ready();
    const stop = createEffect(() => {
      runs += 1;
      void router.navigate("/guarded");
    });
    flushSync();
    await settle();
    expect(runs).toBe(1);
    setFlag(1);
    flushSync();
    expect(runs).toBe(1);
    stop();
    router.dispose();
  });

  it("[RTR-REV-6] a blocker predicate runs untracked when a history change starts inside an effect", () => {
    const [dirty, setDirty] = useSignal(false);
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const capabilities: Capabilities = {};
    blockers().install({
      window: undefined,
      history,
      clock: createFakeClock(0),
      report: () => undefined,
      currentIndex: () => 0,
      capabilities,
      onDispose: () => undefined,
    });
    capabilities.guards?.add(() => (dirty() ? "hold" : "allow"));
    let runs = 0;
    const stop = createEffect(() => {
      runs += 1;
      history.push("/next");
    });
    flushSync();
    expect(runs).toBe(1);
    setDirty(true);
    flushSync();
    expect(runs).toBe(1);
    stop();
  });
});

describe("router review: paths and queues", () => {
  it("[RTR-REV-9] a dot segment written with %2e is resolved like a literal one, as the browser does", () => {
    const here = { pathname: "/a/b", search: "" };
    expect(resolveLocation(here, "/x/%2e%2e/y").pathname).toBe("/y");
    expect(resolveLocation(here, "/x/%2E%2E/y").pathname).toBe("/y");
    expect(resolveLocation(here, "/x/.%2e/y").pathname).toBe("/y");
    expect(resolveLocation(here, "/x/%2e/y").pathname).toBe("/x/y");
    expect(resolveLocation(here, "/x/y/%2e%2e").pathname).toBe("/x/");
    expect(resolveLocation(here, "/x/%2e%2e%2e/y").pathname).toBe("/x/%2e%2e%2e/y");
  });

  it("[RTR-REV-9b] the location the router commits is the one the history holds", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routes: [defineRoute("/", {}), defineRoute("/b", {}), defineRoute("/a/:x/b", {})],
    });
    await router.ready();
    await router.navigate("/a/%2e%2e/b");
    expect(history.location.pathname).toBe("/b");
    expect(router.state.location()?.pathname).toBe("/b");
    expect(router.state.matches().map((m) => m.pattern)).toEqual(["/b"]);
    router.dispose();
  });

  it("[RTR-REV-10] a task that throws before returning a promise is reported and frees its slot", async () => {
    const errors: unknown[] = [];
    const queue = createPrefetchQueue({ concurrency: 1, onError: (error) => errors.push(error) });
    const boom = new Error("sync throw");
    const bad = queue.enqueue("bad", () => {
      throw boom;
    });
    await bad.done;
    expect(errors).toEqual([boom]);
    expect(queue.active).toBe(0);
    let ran = false;
    await queue.enqueue("next", async () => {
      ran = true;
    }).done;
    expect(ran).toBe(true);
  });
});
