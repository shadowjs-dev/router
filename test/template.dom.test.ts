import { flushSync } from "@shadow-js/core";
import { describe, expect, it, vi } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";

interface Counts {
  layouts: number;
  templates: number;
  inner: number;
  templatesDisposed: number;
}

interface TemplateModule {
  counts: Counts;
  start(
    host: HTMLElement,
    mode?: "render" | "hydrate",
  ): Promise<{ router: { navigate(to: string): Promise<unknown>; dispose(): void } }>;
}

interface TemplateServerModule {
  renderUrl(url: string): Promise<string>;
}

/**
 * One tree the way the generator writes it: a root layout, a template inside it (`defineTemplate`
 * around the template module's default export), pages below the template, and a folder with its own
 * layout and template. State lives in signals created inside each component, so a remount is visible
 * as a counter going back to 0.
 */
const BODY = `
  import { createRouter, defineRoute, defineTemplate, RouterProvider, Outlet, createMemoryHistory, useParams } from "@router";
  import { onCleanup, useSignal } from "@shadow-js/core";

  export const counts = { layouts: 0, templates: 0, inner: 0, templatesDisposed: 0 };

  function Layout() {
    counts.layouts += 1;
    const [n, setN] = useSignal(0);
    return <div class="layout"><button class="layout-inc" onClick={() => setN(n() + 1)}>layout:{n()}</button><Outlet /></div>;
  }
  function Template() {
    counts.templates += 1;
    onCleanup(() => { counts.templatesDisposed += 1; });
    const [n, setN] = useSignal(0);
    return <section class="template"><button class="template-inc" onClick={() => setN(n() + 1)}>template:{n()}</button><Outlet /></section>;
  }
  function InnerLayout() {
    return <div class="inner-layout"><Outlet /></div>;
  }
  function InnerTemplate() {
    counts.inner += 1;
    const [n, setN] = useSignal(0);
    return <aside class="inner-template"><button class="inner-inc" onClick={() => setN(n() + 1)}>inner:{n()}</button><Outlet /></aside>;
  }

  const home = defineRoute("/", { id: "/", component: () => <p class="page">home</p> });
  const about = defineRoute("/about", { id: "/about", component: () => <p class="page">about</p> });
  const post = defineRoute("/posts/:id", {
    id: "/posts/:id",
    component: function Post() { const params = useParams(); return <p class="page">post {params.id}</p>; },
  });
  const a = defineRoute("/a", { id: "/dash/a", component: () => <p class="page">dash a</p> });
  const b = defineRoute("/b", { id: "/dash/b", component: () => <p class="page">dash b</p> });
  const innerTemplate = defineRoute("", {
    id: "/dash/_template",
    component: defineTemplate(InnerTemplate),
    children: [a, b],
  });
  const innerLayout = defineRoute("/dash", { id: "/dash/_layout", component: InnerLayout, children: [innerTemplate] });
  const template = defineRoute("", {
    id: "/_template",
    component: defineTemplate(Template),
    children: [home, about, post, innerLayout],
  });
  const layout = defineRoute("", { id: "/_layout", component: Layout, children: [template] });

  function makeRouter(url) {
    return createRouter({ features: everyFeature(), routes: [layout], history: createMemoryHistory({ initialEntries: [url] }) });
  }
`;

const DOM_SOURCE = `
  import { render, hydrate } from "@shadow-js/web";
  ${BODY}
  export async function start(host, mode = "render") {
    const router = makeRouter(host.dataset.url ?? "/");
    await router.ready();
    const view = () => <RouterProvider router={router}><Outlet /></RouterProvider>;
    if (mode === "hydrate") hydrate(view, host); else render(view, host);
    return { router };
  }
`;

const SSR_SOURCE = `
  import { renderToString } from "@shadow-js/web/server";
  ${BODY}
  export async function renderUrl(url) {
    const router = makeRouter(url);
    await router.ready();
    const html = renderToString(() => <RouterProvider router={router}><Outlet /></RouterProvider>);
    router.dispose();
    return html;
  }
`;

const NO_LAYOUT_SOURCE = `
  import { render } from "@shadow-js/web";
  import { createRouter, defineRoute, defineTemplate, RouterProvider, Outlet, createMemoryHistory } from "@router";
  import { useSignal } from "@shadow-js/core";

  export const counts = { layouts: 0, templates: 0, inner: 0, templatesDisposed: 0 };

  function Template() {
    counts.templates += 1;
    const [n, setN] = useSignal(0);
    return <section class="template"><button class="template-inc" onClick={() => setN(n() + 1)}>template:{n()}</button><Outlet /></section>;
  }
  const one = defineRoute("/one", { id: "/one", component: () => <p class="page">one</p> });
  const two = defineRoute("/two", { id: "/two", component: () => <p class="page">two</p> });
  const template = defineRoute("", { id: "/_template", component: defineTemplate(Template), children: [one, two] });
  export async function start(host) {
    const router = createRouter({ features: everyFeature(), routes: [template], history: createMemoryHistory({ initialEntries: ["/one"] }) });
    await router.ready();
    render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return { router };
  }
`;

function press(root: HTMLElement, selector: string): void {
  (root.querySelector(selector) as HTMLElement).click();
  flushSync();
}

/** The markup without hydration keys and region markers: neither carries meaning for these checks. */
function plain(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--\[-->|<!--\]-->/g, "");
}

async function started(url = "/"): Promise<{
  mod: TemplateModule;
  root: HTMLElement;
  router: { navigate(to: string): Promise<unknown>; dispose(): void };
}> {
  const mod = await load<TemplateModule>(DOM_SOURCE);
  const root = host();
  root.dataset["url"] = url;
  const { router } = await mod.start(root);
  await settle();
  return { mod, root, router };
}

describe("_template: remount on navigation", () => {
  it("[TPL-40 I-T7] a template's state resets when navigation goes to a sibling route", async () => {
    const { mod, root, router } = await started("/");
    press(root, ".template-inc");
    press(root, ".template-inc");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:2");
    expect(mod.counts.templates).toBe(1);
    await router.navigate("/about");
    await settle();
    expect(root.querySelector(".page")?.textContent).toBe("about");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:0");
    expect(mod.counts.templates).toBe(2);
    router.dispose();
  });

  it("[TPL-41 I-T7] a layout's state persists across the same navigation", async () => {
    const { mod, root, router } = await started("/");
    press(root, ".layout-inc");
    press(root, ".template-inc");
    await router.navigate("/about");
    await settle();
    expect(root.querySelector(".layout-inc")?.textContent).toBe("layout:1");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:0");
    expect(mod.counts.layouts).toBe(1);
    router.dispose();
  });

  it("[TPL-42 I-T7] a new param on the same route remounts the template (the key is the matched path)", async () => {
    const { mod, root, router } = await started("/posts/1");
    press(root, ".template-inc");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:1");
    await router.navigate("/posts/2");
    await settle();
    expect(root.querySelector(".page")?.textContent).toBe("post 2");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:0");
    expect(mod.counts.templates).toBe(2);
    router.dispose();
  });

  it("[TPL-43 I-T7] a change of search or hash alone does not remount the template", async () => {
    const { mod, root, router } = await started("/about");
    press(root, ".template-inc");
    await router.navigate("/about?x=1");
    await settle();
    await router.navigate("/about?x=1#top");
    await settle();
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:1");
    expect(mod.counts.templates).toBe(1);
    router.dispose();
  });

  it("[TPL-44 I-T7] the template wraps the page inside the layout and the page is rebuilt with it", async () => {
    const { root, router } = await started("/");
    expect(root.querySelector(".layout > .template > .page")?.textContent).toBe("home");
    const before = root.querySelector(".page");
    await router.navigate("/about");
    await settle();
    expect(root.querySelector(".layout > .template > .page")?.textContent).toBe("about");
    expect(root.querySelector(".page")).not.toBe(before);
    expect(root.querySelectorAll(".template")).toHaveLength(1);
    router.dispose();
  });

  it("[TPL-45 I-T7] the previous template instance is disposed with everything it created", async () => {
    const { mod, root, router } = await started("/");
    expect(mod.counts.templatesDisposed).toBe(0);
    await router.navigate("/about");
    await settle();
    expect(mod.counts.templatesDisposed).toBe(1);
    await router.navigate("/posts/9");
    await settle();
    expect(mod.counts.templatesDisposed).toBe(2);
    expect(root.querySelectorAll(".template")).toHaveLength(1);
    router.dispose();
  });

  it("[TPL-46 I-T8] nested templates are keyed by the same matched path: each remounts on a sibling navigation", async () => {
    const { mod, root, router } = await started("/dash/a");
    press(root, ".template-inc");
    press(root, ".inner-inc");
    expect(
      root.querySelector(".layout > .template > .inner-layout > .inner-template > .page")
        ?.textContent,
    ).toBe("dash a");
    await router.navigate("/dash/b");
    await settle();
    expect(root.querySelector(".page")?.textContent).toBe("dash b");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:0");
    expect(root.querySelector(".inner-inc")?.textContent).toBe("inner:0");
    expect(mod.counts.templates).toBe(2);
    expect(mod.counts.inner).toBe(2);
    expect(mod.counts.layouts).toBe(1);
    router.dispose();
  });

  it("[TPL-47 I-T8] navigating out of a nested folder remounts the outer template too", async () => {
    const { mod, root, router } = await started("/dash/a");
    await router.navigate("/about");
    await settle();
    expect(root.querySelector(".inner-template")).toBeNull();
    expect(root.querySelector(".layout > .template > .page")?.textContent).toBe("about");
    expect(mod.counts.templates).toBe(2);
    router.dispose();
  });

  it("[TPL-48 I-T2] a template with no layout above it remounts the same way", async () => {
    const mod = await load<TemplateModule>(NO_LAYOUT_SOURCE);
    const root = host();
    const { router } = await mod.start(root);
    await settle();
    press(root, ".template-inc");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:1");
    expect(root.querySelector(".template > .page")?.textContent).toBe("one");
    await router.navigate("/two");
    await settle();
    expect(root.querySelector(".template > .page")?.textContent).toBe("two");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:0");
    expect(mod.counts.templates).toBe(2);
    router.dispose();
  });
});

describe("_template: server render and hydration", () => {
  it("[TPL-50 I-T9] the server and the client render the same markup for a tree with templates", async () => {
    const ssr = await load<TemplateServerModule>(SSR_SOURCE, "ssr");
    const html = await ssr.renderUrl("/dash/b");
    const { root, router } = await started("/dash/b");
    expect(plain(html)).toBe(root.innerHTML.replace(/<!--\[-->|<!--\]-->/g, ""));
    expect(plain(html)).toContain(
      '<div class="layout"><button class="layout-inc">layout:0</button><section class="template">',
    );
    router.dispose();
  });

  it("[TPL-51 I-T9] hydrating the server markup keeps the nodes, warns about nothing, and the template still remounts", async () => {
    const ssr = await load<TemplateServerModule>(SSR_SOURCE, "ssr");
    const html = await ssr.renderUrl("/about");
    const mod = await load<TemplateModule>(DOM_SOURCE);
    const root = host();
    root.dataset["url"] = "/about";
    root.innerHTML = html;
    const templateNode = root.querySelector(".template");
    const { router } = await mod.start(root, "hydrate");
    await settle();
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(root.querySelector(".template")).toBe(templateNode);
    press(root, ".template-inc");
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:1");
    await router.navigate("/posts/3");
    await settle();
    expect(root.querySelector(".template-inc")?.textContent).toBe("template:0");
    expect(root.querySelector(".page")?.textContent).toBe("post 3");
    router.dispose();
  });

  it("[TPL-52 I-T9] renderToString of the same tree twice gives identical markup", async () => {
    const ssr = await load<TemplateServerModule>(SSR_SOURCE, "ssr");
    const first = await ssr.renderUrl("/posts/5");
    const second = await ssr.renderUrl("/posts/5");
    expect(second).toBe(first);
  });
});
