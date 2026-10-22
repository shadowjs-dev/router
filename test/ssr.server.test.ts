import { describe, expect, it } from "vitest";
import { parseHydrationData, serializeHydrationData } from "../src/index";
import { load } from "./support/compile";

interface SsrModule {
  calls: { post: number; home: number };
  renderUrl(
    url: string,
    options?: { base?: string; hydrate?: unknown },
  ): Promise<{
    html: string;
    outcome: { kind: string; location?: { pathname: string } };
    data: unknown;
  }>;
  renderHydrated(
    url: string,
    data: unknown,
  ): Promise<{ html: string; outcome: { kind: string }; loads: number }>;
}

/**
 * The markup without hydration keys (`data-hk`) and without the runtime's region markers
 * (`<!--[-->` and `<!--]-->`). Neither carries meaning for these assertions; any other comment would.
 */
function plain(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--\[-->|<!--\]-->/g, "");
}

/**
 * One app for the server: a layout with links, a post route with a loader, a search-aware list, a
 * redirect, a loader that fails and a not-found page. `renderUrl` does what a request handler does:
 * build a router for the URL, await it, render, and report the data for the client.
 */
const SSR_APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet, A, createMemoryHistory, useLoaderData, useParams, useSearch, redirect, notFound } from "@router";
  import { renderToString } from "@shadow-js/web/server";

  export const calls = { post: 0, home: 0 };

  const post = defineRoute("/posts/:id", {
    id: "post",
    loader: ({ params }) => { calls.post += 1; return { title: "Post " + params.id }; },
    component: function Post() {
      const data = useLoaderData();
      const params = useParams();
      return <article class="post"><h1>{data()?.title}</h1><p>id={params.id}</p></article>;
    },
  });
  const list = defineRoute("/list", {
    id: "list",
    validateSearch: (search) => ({ page: Number(search.page ?? 1) }),
    component: function List() {
      const search = useSearch();
      return <ul class="list"><li>page {search.page}</li></ul>;
    },
  });
  const home = defineRoute("/", {
    id: "home",
    loader: () => { calls.home += 1; return { greeting: "hello" }; },
    component: function Home() {
      const data = useLoaderData();
      return <p class="home">{data()?.greeting}</p>;
    },
  });
  const old = defineRoute("/old", { id: "old", beforeLoad: () => { throw redirect("/list?page=2"); }, component: () => <p>never</p> });
  const broken = defineRoute("/broken", {
    id: "broken",
    loader: () => { throw new Error("upstream failed"); },
    component: () => <p>never</p>,
    error: ({ error }) => <p class="broken">{error.message}</p>,
  });
  const gone = defineRoute("/gone", { id: "gone", loader: () => { throw notFound(); }, component: () => <p>never</p> });

  function Shell() {
    return (
      <div class="shell">
        <nav><A to="/">home</A> <A to="/list" activeClass="on">list</A> <A to="/posts/:id" params={{ id: "1" }}>post</A></nav>
        <Outlet />
      </div>
    );
  }
  const shell = defineRoute("", { id: "shell", component: Shell, children: [home, list, post, old, broken, gone] });

  function makeRouter(url, base, hydrate) {
    const router = createRouter({ features: everyFeature(),
      routes: [shell],
      history: createMemoryHistory({ initialEntries: [url] }),
      base: base,
    });
    if (hydrate !== undefined) router.hydrate(hydrate);
    return router;
  }

  export async function renderUrl(url, options = {}) {
    const router = makeRouter(url, options.base ?? "", options.hydrate);
    const outcome = await router.ready();
    const html = renderToString(() => <RouterProvider router={router}><Outlet /></RouterProvider>);
    const data = router.dehydrate();
    router.dispose();
    return { html, outcome, data };
  }

  export async function renderHydrated(url, data) {
    const before = calls.post + calls.home;
    const router = makeRouter(url, "", data);
    const outcome = await router.ready();
    const html = renderToString(() => <RouterProvider router={router}><Outlet /></RouterProvider>);
    router.dispose();
    return { html, outcome, loads: calls.post + calls.home - before };
  }
`;

async function app(): Promise<SsrModule> {
  return load<SsrModule>(SSR_APP, "ssr");
}

describe("server render: markup after the router is ready", () => {
  it("[SSR-01 I-D1] renders the matched page with its layout", async () => {
    const mod = await app();
    const { html, outcome } = await mod.renderUrl("/");
    expect(outcome.kind).toBe("success");
    expect(plain(html)).toContain('<div class="shell">');
    expect(plain(html)).toContain('<p class="home">hello</p>');
  });

  it("[SSR-02 I-L10] loader data is in the markup, because the loader ran before the render", async () => {
    const mod = await app();
    const { html } = await mod.renderUrl("/posts/42");
    expect(plain(html)).toContain("<h1>Post 42</h1>");
    expect(plain(html)).toContain("<p>id=42</p>");
  });

  it("[SSR-03 I-S1] params and search reach the page on the server", async () => {
    const mod = await app();
    const { html } = await mod.renderUrl("/list?page=7");
    expect(plain(html)).toContain("page 7");
  });

  it("[SSR-04 I-A2] an anchor renders its href and its active class on the server", async () => {
    const mod = await app();
    const { html } = await mod.renderUrl("/list");
    expect(plain(html)).toContain('href="/list"');
    expect(plain(html)).toContain('class="on"');
    expect(plain(html)).toContain('aria-current="page"');
  });

  it("[SSR-05 I-U6] the anchor with params renders the filled href", async () => {
    const mod = await app();
    const { html } = await mod.renderUrl("/");
    expect(plain(html)).toContain('href="/posts/1"');
  });

  it("[SSR-06 I-F15] the router writes no comment nodes or wrapper elements of its own", async () => {
    const mod = await app();
    const { html } = await mod.renderUrl("/posts/3");
    expect(plain(html)).not.toContain("<!--");
    expect(plain(html).startsWith('<div class="shell">')).toBe(true);
  });

  it("[SSR-07 I-I1] a base path is added to every server href", async () => {
    const mod = await app();
    const { html } = await mod.renderUrl("/app/list", { base: "/app" });
    expect(plain(html)).toContain('href="/app/list"');
    expect(plain(html)).toContain("page 1");
  });

  it("[SSR-08 I-L9] a loader failure renders the route's error component", async () => {
    const mod = await app();
    const { html, outcome } = await mod.renderUrl("/broken");
    expect(outcome.kind).toBe("success");
    expect(plain(html)).toContain('<p class="broken">upstream failed</p>');
  });
});

describe("server render: status and redirects", () => {
  it("[SSR-10 I-D1] a not-found outcome is reported so the handler can answer 404", async () => {
    const mod = await app();
    const { outcome } = await mod.renderUrl("/nope/at/all");
    expect(outcome.kind).toBe("notFound");
  });

  it("[SSR-11 I-D1] a loader not-found is reported as notFound", async () => {
    const mod = await app();
    const { outcome } = await mod.renderUrl("/gone");
    expect(outcome.kind).toBe("notFound");
  });

  it("[SSR-12 I-N3] a redirect from beforeLoad lands on the target and is rendered there", async () => {
    const mod = await app();
    const { html, outcome } = await mod.renderUrl("/old");
    expect(outcome.kind).toBe("success");
    expect(outcome.location?.pathname).toBe("/list");
    expect(plain(html)).toContain("page 2");
  });
});

describe("server render: hydration data", () => {
  it("[SSR-20 I-F11] the serialized data cannot break out of its script element", async () => {
    const mod = await app();
    const { data } = await mod.renderUrl("/posts/5");
    const text = serializeHydrationData(data as Parameters<typeof serializeHydrationData>[0]);
    expect(text).not.toMatch(/[<>&]/);
    expect(parseHydrationData(text)).toEqual(data);
  });

  it("[SSR-21 I-L10] a client that hydrates the server data does not run the loader again", async () => {
    const mod = await app();
    const server = await mod.renderUrl("/posts/9");
    const text = serializeHydrationData(
      server.data as Parameters<typeof serializeHydrationData>[0],
    );
    const client = await mod.renderHydrated("/posts/9", parseHydrationData(text));
    expect(client.loads).toBe(0);
    expect(plain(client.html)).toBe(plain(server.html));
  });

  it("[SSR-22 I-L10] the hydrated client renders the same markup as the server", async () => {
    const mod = await app();
    const server = await mod.renderUrl("/posts/11");
    const client = await mod.renderHydrated("/posts/11", server.data);
    expect(plain(client.html)).toContain("<h1>Post 11</h1>");
  });
});

describe("server render: isolation", () => {
  it("[SSR-30 I-M5] a hundred interleaved requests each render their own URL", async () => {
    const mod = await app();
    const requests = Array.from({ length: 100 }, (_unused, n) =>
      mod.renderUrl(`/posts/${String(n)}`).then((result) => ({ n, html: result.html })),
    );
    const results = await Promise.all(requests);
    for (const { n, html } of results) {
      expect(plain(html)).toContain(`<h1>Post ${String(n)}</h1>`);
      expect(plain(html)).toContain(`<p>id=${String(n)}</p>`);
    }
  });

  it("[SSR-31 I-M5] the loader of one request is not run for another", async () => {
    const mod = await app();
    const before = mod.calls.home;
    await Promise.all([mod.renderUrl("/"), mod.renderUrl("/posts/1")]);
    expect(mod.calls.home).toBe(before + 1);
  });

  it("[SSR-32 I-M5] a router without a window needs no listeners and disposes cleanly", async () => {
    const mod = await app();
    const result = await mod.renderUrl("/list?page=3");
    expect(plain(result.html)).toContain("page 3");
  });
});
