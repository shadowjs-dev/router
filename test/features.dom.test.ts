import { flushSync } from "@shadow-js/core";
import { createComponent, render } from "@shadow-js/web";
import { describe, expect, it } from "vitest";
import { createMemoryHistory } from "../src/core/index";
import { blockers, useBlocker } from "../src/features/blockers";
import { errorBoundaries } from "../src/features/errors";
import { createRouter, defineRoute, Outlet, RouterProvider } from "../src/index";
import { host, settle } from "./support/app";

describe("router features: hooks that need a feature", () => {
  it("[FEAT-10] useBlocker without the blockers feature throws a TypeError that names the feature", async () => {
    const root = host();
    // The route's error component shows the thrown error, so the test reads the message from the screen.
    const page = defineRoute("/", {
      error: ({ error }) => `caught: ${error instanceof Error ? error.message : String(error)}`,
      component: () => {
        useBlocker(() => true);
        return "page";
      },
    });
    const router = createRouter({
      routes: [page],
      features: [errorBoundaries()],
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      () =>
        createComponent(RouterProvider, {
          router,
          get children(): unknown {
            return createComponent(Outlet, {});
          },
        }),
      root,
    );
    await router.ready();
    flushSync();
    await settle();
    expect(root.textContent).toContain("useBlocker() needs the blockers feature");
  });

  it("[FEAT-11] with the blockers feature the same hook holds a navigation until proceed()", async () => {
    const root = host();
    let held: { proceed(): void } | undefined;
    const page = defineRoute("/", {
      component: () => {
        const blocker = useBlocker(() => true);
        held = blocker;
        return "page";
      },
    });
    const other = defineRoute("/other", { component: () => "other" });
    const router = createRouter({
      routes: [page, other],
      history: createMemoryHistory({ initialEntries: ["/"] }),
      features: [blockers()],
    });
    render(
      () =>
        createComponent(RouterProvider, {
          router,
          get children(): unknown {
            return createComponent(Outlet, {});
          },
        }),
      root,
    );
    await router.ready();
    flushSync();
    await settle();
    void router.navigate("/other");
    await settle();
    expect(router.history.location.pathname).toBe("/");
    expect(held).toBeDefined();
    held?.proceed();
    await settle();
    expect(router.history.location.pathname).toBe("/other");
    router.dispose();
  });
});
