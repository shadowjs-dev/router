import { flushSync } from "@shadow-js/core";
import { createComponent, render } from "@shadow-js/web";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, type SearchRecord } from "../src/core/index";
import { blockers, useBlocker } from "../src/features/blockers";
import { notFoundUi } from "../src/features/not-found";
import { createRouter, defineRoute, Outlet, RouterProvider, useSearchParams } from "../src/index";
import { host, settle } from "./support/app";

function mount(router: ReturnType<typeof createRouter>, root: HTMLElement): void {
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
}

describe("useSearchParams: the setter merges into the current query", () => {
  it("[RTR-R7-2] setting one key keeps the others, and the hash", async () => {
    const root = host();
    let setParams: ((next: Record<string, string | number | undefined>) => void) | undefined;
    const page = defineRoute("/", {
      component: () => {
        const [, set] = useSearchParams<SearchRecord>();
        setParams = set;
        return "page";
      },
    });
    const router = createRouter({
      routes: [page],
      history: createMemoryHistory({ initialEntries: ["/?a=1&b=2#top"] }),
    });
    mount(router, root);
    await router.ready();
    flushSync();
    await settle();
    setParams?.({ a: 3 });
    await settle();
    expect(router.history.location.search).toBe("?a=3&b=2");
    expect(router.history.location.hash).toBe("#top");
    setParams?.({ b: undefined });
    await settle();
    expect(router.history.location.search).toBe("?a=3");
    router.dispose();
  });
});

describe("useBlocker: the hold ends with the held transition", () => {
  it("[RTR-R7-3] a later navigation that gets through leaves the blocker idle", async () => {
    const root = host();
    let dirty = true;
    let blocker: ReturnType<typeof useBlocker> | undefined;
    const page = defineRoute("/", {
      component: () => {
        blocker = useBlocker(() => dirty);
        return "page";
      },
    });
    const other = defineRoute("/other", { component: () => "other" });
    const router = createRouter({
      routes: [page, other],
      history: createMemoryHistory({ initialEntries: ["/"] }),
      features: [blockers()],
    });
    mount(router, root);
    await router.ready();
    flushSync();
    await settle();
    void router.navigate("/other");
    await settle();
    expect(blocker?.status()).toBe("blocked");
    dirty = false;
    const outcome = await router.navigate("/other");
    await settle();
    expect(outcome.kind).toBe("success");
    expect(router.history.location.pathname).toBe("/other");
    expect(blocker?.status()).toBe("idle");
    expect(blocker?.transition()).toBeUndefined();
    router.dispose();
  });
});

describe("a root not-found renders for a malformed path", () => {
  const home = defineRoute("/", { component: () => "home" });
  const shell = defineRoute("", {
    id: "shell",
    component: () => createComponent(Outlet, {}),
    notFound: () => "nothing here",
    children: [home],
  });

  it.each(["/%zz", "/a//b"])("[RTR-R7-5] landing on %s shows the not-found UI", async (url) => {
    const root = host();
    const router = createRouter({
      routes: [shell],
      features: [notFoundUi()],
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    mount(router, root);
    await router.ready();
    flushSync();
    await settle();
    expect(root.textContent).toContain("nothing here");
    router.dispose();
  });

  it("[RTR-R7-5] navigating to a malformed path replaces the page and moves the URL", async () => {
    const root = host();
    const router = createRouter({
      routes: [shell],
      features: [notFoundUi()],
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    mount(router, root);
    await router.ready();
    flushSync();
    await settle();
    expect(root.textContent).toContain("home");
    await router.navigate("/%zz");
    flushSync();
    await settle();
    expect(root.textContent).toContain("nothing here");
    expect(router.history.location.pathname).toBe("/%zz");
    router.dispose();
  });
});
