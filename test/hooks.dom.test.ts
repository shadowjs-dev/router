import { flushSync } from "@shadow-js/core";
import { createComponent, render } from "@shadow-js/web";
import { describe, expect, it } from "vitest";
import {
  createMemoryHistory,
  createRouter,
  defineRoute,
  Outlet,
  RouterProvider,
} from "../src/index";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { featuresWithout } from "./support/features";
import { RouterTestWindow } from "./support/router-window";

interface PostsModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
  ): { navigate(to: string): Promise<unknown>; dispose(): void };
  log: string[];
  runs: Record<string, number>;
}

/** Posts with params, search and loader data; each key has a reader that counts its own reruns. */
const POSTS = `
  import { createRouter, defineRoute, RouterProvider, Outlet, useParams, useSearch, useLoaderData, useLocation, useNavigation, useMatches } from "@router";
  import { render } from "@shadow-js/web";
  import { useEffect } from "@shadow-js/core";

  export const log = [];
  export const runs = { page: 0, tab: 0, id: 0, section: 0 };

  const posts = defineRoute("/posts/:id/:section", {
    id: "posts",
    validateSearch: (search) => ({ page: Number(search.page ?? 1), tab: String(search.tab ?? "a") }),
    loader: ({ params }) => ({ title: "post " + params.id }),
    component: function Post() {
      const params = useParams();
      const search = useSearch();
      const data = useLoaderData();
      useEffect(() => { runs.page += 1; search.page; });
      useEffect(() => { runs.tab += 1; search.tab; });
      useEffect(() => { runs.id += 1; params.id; });
      useEffect(() => { runs.section += 1; params.section; });
      return <section><h1>{data()?.title}</h1><p>{params.id}/{params.section}</p><p>{search.page}:{search.tab}</p></section>;
    },
  });
  const other = defineRoute("/other", { id: "other", component: () => <p>other</p> });

  function Probe() {
    const location = useLocation();
    const navigation = useNavigation();
    const matches = useMatches();
    useEffect(() => { log.push("loc:" + location.pathname + location.search); });
    useEffect(() => { log.push("pending:" + String(navigation.pending)); });
    useEffect(() => { log.push("matches:" + matches().map((m) => m.id).join(",")); });
    return <i class="probe">{location.pathname}</i>;
  }

  export function start(host, win) {
    const router = createRouter({ features: everyFeature(), routes: [other, posts], window: win, clock: undefined });
    render(() => <RouterProvider router={router}><Probe /><Outlet /></RouterProvider>, host);
    return router;
  }
`;

describe("per-key reads: useParams and useSearch", () => {
  it("[KEY-01 I-S7] changing one search key reruns only the readers of that key", async () => {
    const mod = await load<PostsModule>(POSTS);
    const root = host();
    const win = new RouterTestWindow("/posts/1/x?page=1&tab=a");
    const router = mod.start(root, win);
    await settle();
    const before = { ...mod.runs };
    await router.navigate("/posts/1/x?page=2&tab=a");
    await settle();
    expect(mod.runs["page"]).toBe((before["page"] ?? 0) + 1);
    expect(mod.runs["tab"]).toBe(before["tab"]);
    router.dispose();
  });

  it("[KEY-02 I-S7] changing one param reruns only the readers of that param", async () => {
    const mod = await load<PostsModule>(POSTS);
    const root = host();
    const win = new RouterTestWindow("/posts/1/x");
    const router = mod.start(root, win);
    await settle();
    const before = { ...mod.runs };
    await router.navigate("/posts/1/y");
    await settle();
    expect(mod.runs["section"]).toBe((before["section"] ?? 0) + 1);
    expect(mod.runs["id"]).toBe(before["id"]);
    router.dispose();
  });

  it("[KEY-03 I-S7] the rendered output follows the validated search", async () => {
    const mod = await load<PostsModule>(POSTS);
    const root = host();
    const win = new RouterTestWindow("/posts/3/x");
    const router = mod.start(root, win);
    await settle();
    expect(root.querySelector("section > p:last-child")?.textContent).toBe("1:a");
    await router.navigate("/posts/3/x?tab=zz&page=4");
    await settle();
    expect(root.querySelector("section > p:last-child")?.textContent).toBe("4:zz");
    router.dispose();
  });

  it("[KEY-04 I-L11] the loader title follows the param through useLoaderData", async () => {
    const mod = await load<PostsModule>(POSTS);
    const root = host();
    const win = new RouterTestWindow("/posts/5/x");
    const router = mod.start(root, win);
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("post 5");
    await router.navigate("/posts/6/x");
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("post 6");
    router.dispose();
  });
});

describe("hooks: location, navigation and matches", () => {
  it("[HOOK-01 I-N13] useLocation tracks the app pathname and search", async () => {
    const mod = await load<PostsModule>(POSTS);
    const root = host();
    const win = new RouterTestWindow("/other");
    const router = mod.start(root, win);
    await settle();
    expect(mod.log).toContain("loc:/other");
    await router.navigate("/posts/1/x?x=1");
    await settle();
    expect(mod.log).toContain("loc:/posts/1/x?x=1");
    router.dispose();
  });

  it("[HOOK-02 I-M3] useMatches lists the chain on screen", async () => {
    const mod = await load<PostsModule>(POSTS);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/posts/1/x"));
    await settle();
    expect(mod.log).toContain("matches:posts");
    router.dispose();
  });

  it("[HOOK-03 I-N6] useNavigation reports not pending once a fast navigation completes", async () => {
    const mod = await load<PostsModule>(POSTS);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/other"));
    await settle();
    await router.navigate("/posts/1/x");
    await settle();
    expect(mod.log).toContain("matches:posts");
    expect(mod.log.filter((entry) => entry.startsWith("pending:")).at(-1)).toBe("pending:false");
    router.dispose();
  });

  it("[HOOK-04 I-M5] useRouter outside a RouterProvider throws a TypeError naming the hook", async () => {
    const outside = await load<{ probe(): void }>(`
      import { useRouter } from "@router";
      export function probe() { return useRouter(); }
    `);
    expect(() => outside.probe()).toThrow(/useRouter\(\) must be used inside <RouterProvider>/);
  });

  it("[HOOK-05 I-N3] useNavigate returns a function bound to the router", async () => {
    const mod = await load<{
      nav: { go: ((to: string) => Promise<unknown>) | null };
      mount(host: HTMLElement, win: RouterTestWindow): unknown;
    }>(`
      import { createRouter, defineRoute, RouterProvider, Outlet, useNavigate } from "@router";
      import { render } from "@shadow-js/web";
      export const nav = { go: null };
      function Grab() { nav.go = useNavigate(); return null; }
      const a = defineRoute("/a", { component: () => <p>a</p> });
      const b = defineRoute("/b", { component: () => <p>b</p> });
      export function mount(host, win) {
        const router = createRouter({ features: everyFeature(), routes: [a, b], window: win });
        render(() => <RouterProvider router={router}><Grab /><Outlet /></RouterProvider>, host);
        return router;
      }
    `);
    const root = host();
    const win = new RouterTestWindow("/a");
    mod.mount(root, win);
    await settle();
    const go = mod.nav.go;
    expect(go).not.toBeNull();
    await go?.("/b");
    await settle();
    expect(root.textContent).toBe("b");
  });

  it("[HOOK-06 I-N13] useHref follows the current location for a relative target", async () => {
    const mod = await load<{
      seen: string[];
      mount(host: HTMLElement, win: RouterTestWindow): { navigate(to: string): Promise<unknown> };
    }>(`
      import { createRouter, defineRoute, RouterProvider, Outlet, useHref } from "@router";
      import { render } from "@shadow-js/web";
      import { useEffect } from "@shadow-js/core";
      export const seen = [];
      function Link() {
        const href = useHref("?tab=2");
        useEffect(() => { seen.push(href()); });
        return <a>link</a>;
      }
      const a = defineRoute("/a", { component: () => <p>a</p> });
      const b = defineRoute("/b", { component: () => <p>b</p> });
      export function mount(host, win) {
        const router = createRouter({ features: everyFeature(), routes: [a, b], window: win });
        render(() => <RouterProvider router={router}><Link /><Outlet /></RouterProvider>, host);
        return router;
      }
    `);
    const router = mod.mount(host(), new RouterTestWindow("/a"));
    await settle();
    await router.navigate("/b");
    await settle();
    expect(mod.seen).toEqual(["/a?tab=2", "/b?tab=2"]);
  });

  it("[HOOK-07 I-N3] a Navigate element navigates when it renders, replacing when asked", async () => {
    const mod = await load<{
      mount(host: HTMLElement, win: RouterTestWindow): { navigate(to: string): Promise<unknown> };
    }>(`
      import { createRouter, defineRoute, RouterProvider, Outlet, Navigate } from "@router";
      import { render } from "@shadow-js/web";
      const login = defineRoute("/login", { component: () => <p>login</p> });
      const gate = defineRoute("/gate", { component: () => <Navigate to="/login" replace /> });
      export function mount(host, win) {
        const router = createRouter({ features: everyFeature(), routes: [login, gate], window: win });
        render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
        return router;
      }
    `);
    const root = host();
    const win = new RouterTestWindow("/login");
    const router = mod.mount(root, win);
    const before = win.entryCount;
    await router.navigate("/gate");
    await settle();
    expect(root.textContent).toBe("login");
    expect(win.location.pathname).toBe("/login");
    expect(win.entryCount).toBe(before + 1);
  });

  it("[HOOK-08 I-S7] a route's own typed helpers read its params without a from argument", async () => {
    const mod = await load<{
      user: { useParams(): { name: string }; useLoaderData(): () => unknown };
      mount(host: HTMLElement, win: RouterTestWindow): unknown;
    }>(`
      import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
      import { render } from "@shadow-js/web";
      export const user = defineRoute("/users/:name", {
        component: () => <p>user</p>,
      });
      export function mount(host, win) {
        const router = createRouter({ features: everyFeature(), routes: [user], window: win });
        render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
        return router;
      }
    `);
    const root = host();
    mod.mount(root, new RouterTestWindow("/users/ada"));
    await settle();
    expect(root.textContent).toBe("user");
  });
});

describe("createRouter with an explicit memory history", () => {
  it("[HOOK-09 I-N6] a memory-history router renders its matched route and navigates", async () => {
    const root = host();
    const a = defineRoute("/a", { component: () => "page-a" });
    const b = defineRoute("/b", { component: () => "page-b" });
    const router = createRouter({
      features: featuresWithout("scroll"),
      routes: [a, b],
      history: createMemoryHistory({ initialEntries: ["/a"] }),
      clock: createFakeClock(0),
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
    expect(root.textContent).toBe("page-a");
    await router.navigate("/b");
    await settle();
    expect(root.textContent).toBe("page-b");
    router.dispose();
  });
});
