import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, defineRoute, redirect } from "../src/index";
import { deferred } from "./support/deferred";
import { featuresWithout } from "./support/features";
import { rig, settle } from "./support/rig";

describe("navigation races: the last navigation wins", () => {
  it("[RACE-01 I-N1] a slow loader from an older navigation never commits after a newer one", async () => {
    const slow = deferred<string>();
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/slow", { loader: () => slow.promise }),
      defineRoute("/fast", { loader: () => "fast" }),
    ]);
    await r.router.ready();
    const first = r.router.navigate("/slow");
    await settle();
    await r.router.navigate("/fast");
    slow.resolve("late");
    await first;
    await settle();
    expect(r.router.state.location()?.pathname).toBe("/fast");
    expect(r.router.state.matches().map((m) => m.id)).toEqual(["/fast"]);
    r.router.dispose();
  });

  it("[RACE-02 I-N1] the superseded navigation resolves as canceled", async () => {
    const slow = deferred<string>();
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/slow", { loader: () => slow.promise }),
      defineRoute("/fast", {}),
    ]);
    await r.router.ready();
    const first = r.router.navigate("/slow");
    await settle();
    await r.router.navigate("/fast");
    slow.resolve("late");
    expect((await first).kind).toBe("canceled");
    r.router.dispose();
  });

  it("[RACE-03 I-N1] the loader signal of a superseded navigation is aborted", async () => {
    let signal: AbortSignal | undefined;
    const hang = deferred<void>();
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/hang", {
        loader: (args) => {
          signal = args.signal;
          return hang.promise;
        },
      }),
      defineRoute("/next", {}),
    ]);
    await r.router.ready();
    void r.router.navigate("/hang");
    await settle();
    expect(signal?.aborted).toBe(false);
    await r.router.navigate("/next");
    expect(signal?.aborted).toBe(true);
    r.router.dispose();
  });

  it("[RACE-04 I-N5] a preload and a navigation to the same target share one loader run", async () => {
    let runs = 0;
    const gate = deferred<string>();
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/item", {
        loader: () => {
          runs += 1;
          return gate.promise;
        },
      }),
    ]);
    await r.router.ready();
    const preloading = r.router.preload("/item");
    await settle();
    const navigating = r.router.navigate("/item");
    await settle();
    gate.resolve("done");
    await Promise.all([preloading, navigating]);
    await settle();
    expect(runs).toBe(1);
    expect(r.router.state.location()?.pathname).toBe("/item");
    r.router.dispose();
  });

  it("[RACE-05 I-N4] a preload that is still running does not change the committed location", async () => {
    const gate = deferred<string>();
    const r = rig([defineRoute("/", {}), defineRoute("/item", { loader: () => gate.promise })]);
    await r.router.ready();
    void r.router.preload("/item");
    await settle();
    expect(r.router.state.location()?.pathname).toBe("/");
    gate.resolve("done");
    await settle();
    expect(r.router.state.location()?.pathname).toBe("/");
    r.router.dispose();
  });

  it("[RACE-06 I-N1] a hundred rapid navigations end on the last target and never commit an older one", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/n/:id", { loader: ({ params }) => params["id"] }),
    ]);
    await r.router.ready();
    const outcomes: Array<Promise<unknown>> = [];
    for (let n = 0; n < 100; n += 1) outcomes.push(r.router.navigate(`/n/${n}`));
    await Promise.all(outcomes);
    await settle();
    expect(r.router.state.matches()[0]?.params).toEqual({ id: "99" });
    expect(r.router.state.location()?.pathname).toBe("/n/99");
    r.router.dispose();
  });

  it("[RACE-07 I-N1] a redirect target that is superseded does not commit", async () => {
    const gate = deferred<string>();
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/go", {
        beforeLoad: () => {
          throw redirect("/moved");
        },
      }),
      defineRoute("/moved", { loader: () => gate.promise }),
      defineRoute("/final", {}),
    ]);
    await r.router.ready();
    const going = r.router.navigate("/go");
    await settle();
    await r.router.navigate("/final");
    gate.resolve("late");
    await going;
    await settle();
    expect(r.router.state.location()?.pathname).toBe("/final");
    expect(r.errors).toEqual([]);
    r.router.dispose();
  });

  it("[RACE-08 I-N1] a navigation started during a redirect hop wins over the redirected one", async () => {
    const hop = deferred<void>();
    const router = createRouter({
      features: featuresWithout("scroll"),
      routes: [
        defineRoute("/a", {
          beforeLoad: async () => {
            await hop.promise;
            throw new Error("boom");
          },
        }),
        defineRoute("/b", {}),
      ],
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.ready();
    const first = router.navigate("/a");
    await settle();
    const second = router.navigate("/b");
    hop.resolve();
    await Promise.all([first, second]);
    await settle();
    expect(router.state.location()?.pathname).toBe("/b");
    router.dispose();
  });
});
