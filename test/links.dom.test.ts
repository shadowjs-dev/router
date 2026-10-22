import { describe, expect, it, vi } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { RouterTestWindow } from "./support/router-window";

interface LinkModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    options?: { base?: string },
  ): {
    navigate(to: string): Promise<unknown>;
    preloads: string[];
    dispose(): void;
  };
  preloads: string[];
}

/**
 * Builds a module that renders `links` (JSX) inside the router. Every route's loader records its own
 * path in `preloads`, so a test can see what a hover or focus fetched.
 */
async function linkPage(links: string, extra = ""): Promise<LinkModule> {
  return load<LinkModule>(`
    import { createRouter, defineRoute, RouterProvider, Outlet, A, useParams } from "@router";
    import { render } from "@shadow-js/web";
    export const preloads = [];
    const loader = (name) => () => { preloads.push(name); return name; };
    const home = defineRoute("/", { id: "home", loader: loader("home"), component: () => <p>home</p> });
    const list = defineRoute("/list", { id: "list", loader: loader("list"), component: () => <p>list</p> });
    const posts = defineRoute("/posts/:id", { id: "posts", loader: ({ params }) => { preloads.push("post:" + params.id); return params.id; }, component: () => <p>post</p> });
    const docs = defineRoute("/docs", { id: "docs", component: () => <p>docs</p> });
    const deep = defineRoute("/list/extra", { id: "deep", component: () => <p>deep</p> });
    function Page() {
      return (
        <div>
          <nav>
            ${links}
          </nav>
          <Outlet />
        </div>
      );
    }
    ${extra}
    const shell = defineRoute("", { id: "shell", component: Page, children: [home, list, posts, docs, deep] });
    export function start(host, win, options = {}) {
      const router = createRouter({ features: everyFeature(), routes: [shell], window: win, base: options.base ?? "", clock: undefined });
      render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
      return { navigate: (to) => router.navigate(to), preloads, dispose: () => router.dispose() };
    }
  `);
}

/**
 * Clicks an element and reports whether the router's handler prevented the default action. The
 * probe runs on the window in the bubble phase, after the anchor's own handler, and records the
 * flag before blocking the browser's navigation (happy-dom would otherwise fetch the href).
 */
function click(element: Element, init: MouseEventInit = {}): { readonly prevented: boolean } {
  let prevented = false;
  const probe = (event: Event): void => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("click", probe);
  try {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  } finally {
    window.removeEventListener("click", probe);
  }
  return { prevented };
}

describe("A: click handling matrix", () => {
  it("[LINK-01 I-A1] a plain primary click navigates through the router and prevents the browser default", async () => {
    const mod = await linkPage(`<A to="/list" class="go">list</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const event = click(root.querySelector("a.go") as Element);
    await settle();
    expect(event.prevented).toBe(true);
    expect(win.location.pathname).toBe("/list");
    router.dispose();
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["altKey", { altKey: true }],
    ["shiftKey", { shiftKey: true }],
  ])("[LINK-02 I-A1] a click with %s is left to the browser", async (_name, init) => {
    const mod = await linkPage(`<A to="/list" class="go">list</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const event = click(root.querySelector("a.go") as Element, init);
    await settle();
    expect(event.prevented).toBe(false);
    expect(win.location.pathname).toBe("/");
    router.dispose();
  });

  it("[LINK-03 I-A1] a middle-button click is left to the browser", async () => {
    const mod = await linkPage(`<A to="/list" class="go">list</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const event = click(root.querySelector("a.go") as Element, { button: 1 });
    await settle();
    expect(event.prevented).toBe(false);
    expect(win.location.pathname).toBe("/");
    router.dispose();
  });

  it("[LINK-04 I-A1] target=_blank is left to the browser", async () => {
    const mod = await linkPage(`<A to="/list" target="_blank" class="go">list</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const event = click(root.querySelector("a.go") as Element);
    expect(event.prevented).toBe(false);
    router.dispose();
  });

  it("[LINK-05 I-A1] target=_self is handled by the router", async () => {
    const mod = await linkPage(`<A to="/list" target="_self" class="go">list</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const event = click(root.querySelector("a.go") as Element);
    await settle();
    expect(event.prevented).toBe(true);
    router.dispose();
  });

  it("[LINK-06 I-A1] a download link is left to the browser", async () => {
    const mod = await linkPage(`<A to="/list" download class="go">list</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    const event = click(root.querySelector("a.go") as Element);
    expect(event.prevented).toBe(false);
    router.dispose();
  });

  it("[LINK-07 I-A1] rel=external is left to the browser", async () => {
    const mod = await linkPage(`<A to="/list" rel="noopener external" class="go">list</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    const event = click(root.querySelector("a.go") as Element);
    expect(event.prevented).toBe(false);
    router.dispose();
  });

  it("[LINK-08 I-A1] an absolute external href renders as a plain link and is not intercepted", async () => {
    const mod = await linkPage(`<A href="https://other.example/x" class="go">out</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    const anchor = root.querySelector("a.go");
    expect(anchor?.getAttribute("href")).toBe("https://other.example/x");
    expect(click(anchor as Element).prevented).toBe(false);
    router.dispose();
  });

  it("[LINK-09 I-A1] mailto and tel links are never routed", async () => {
    const mod = await linkPage(`<A href="mailto:a@example.test" class="mail">mail</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    expect(click(root.querySelector("a.mail") as Element).prevented).toBe(false);
    router.dispose();
  });

  it("[LINK-10 I-A1] a javascript: target renders no href and is not routed", async () => {
    const mod = await linkPage(`<A href="javascript:alert(1)" class="bad">bad</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const anchor = root.querySelector("a.bad");
    expect(anchor?.hasAttribute("href")).toBe(false);
    expect(click(anchor as Element).prevented).toBe(false);
    expect(win.location.pathname).toBe("/");
    router.dispose();
  });

  it("[LINK-11 I-A1] a protocol-relative href is treated as external", async () => {
    const mod = await linkPage(`<A href="//evil.example/x" class="pr">pr</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    expect(click(root.querySelector("a.pr") as Element).prevented).toBe(false);
    router.dispose();
  });

  it("[LINK-12 I-A1] a right-click (button 2) is left to the browser", async () => {
    const mod = await linkPage(`<A to="/list" class="go">list</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    expect(click(root.querySelector("a.go") as Element, { button: 2 }).prevented).toBe(false);
    router.dispose();
  });

  it("[LINK-13 I-A1] an already prevented click is left alone", async () => {
    const mod = await linkPage(`<A to="/list" class="go">list</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const anchor = root.querySelector("a.go") as Element;
    anchor.addEventListener("click", (event) => event.preventDefault(), { capture: true });
    click(anchor);
    await settle();
    expect(win.location.pathname).toBe("/");
    router.dispose();
  });
});

describe("A: targets and options", () => {
  it("[LINK-20 I-A1] a pattern with params renders the filled href", async () => {
    const mod = await linkPage(`<A to="/posts/:id" params={{ id: "7" }} class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    expect(root.querySelector("a.go")?.getAttribute("href")).toBe("/posts/7");
    router.dispose();
  });

  it("[LINK-21 I-A1] search and hash render into the href", async () => {
    const mod = await linkPage(`<A to="/list" search={{ page: 2 }} hash="top" class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    expect(root.querySelector("a.go")?.getAttribute("href")).toBe("/list?page=2#top");
    router.dispose();
  });

  it("[LINK-22 I-A1] a click with replace does not add a history entry", async () => {
    const mod = await linkPage(`<A to="/list" replace class="go">p</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const before = win.entryCount;
    click(root.querySelector("a.go") as Element);
    await settle();
    expect(win.entryCount).toBe(before);
    expect(win.location.pathname).toBe("/list");
    router.dispose();
  });

  it("[LINK-23 I-A1] a click without replace pushes an entry", async () => {
    const mod = await linkPage(`<A to="/list" class="go">p</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    const before = win.entryCount;
    click(root.querySelector("a.go") as Element);
    await settle();
    expect(win.entryCount).toBe(before + 1);
    router.dispose();
  });

  it("[LINK-24 I-A1] children render inside the anchor", async () => {
    const mod = await linkPage(`<A to="/list" class="go"><b>bold</b> text</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    expect(root.querySelector("a.go")?.innerHTML).toBe("<b>bold</b> text");
    router.dispose();
  });

  it("[LINK-25 I-A1] a user class and the active class are both applied", async () => {
    const mod = await linkPage(`<A to="/list" class="base" activeClass="on">p</A>`);
    const root = host();
    const win = new RouterTestWindow("/list");
    const router = mod.start(root, win);
    await settle();
    expect(root.querySelector("a")?.className).toBe("base on");
    router.dispose();
  });

  it("[LINK-26 I-A1] an anchor outside a RouterProvider throws naming A", async () => {
    const outside = await load<{ make(): unknown }>(`
      import { A } from "@router";
      export function make() { return <A to="/x">x</A>; }
    `);
    expect(() => outside.make()).toThrow(/A\(\) must be used inside <RouterProvider>/);
  });
});

describe("A: active state", () => {
  it("[LINK-30 I-A2] the exact location sets aria-current=page and the active class", async () => {
    const mod = await linkPage(`<A to="/list" activeClass="on" class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/list"));
    await settle();
    const anchor = root.querySelector("a.go");
    expect(anchor?.getAttribute("aria-current")).toBe("page");
    expect(anchor?.classList.contains("on")).toBe(true);
    router.dispose();
  });

  it("[LINK-31 I-A2] a location below the target is partially active without aria-current", async () => {
    const mod = await linkPage(`<A to="/list" activeClass="on" class="go">p</A>`);
    const root = host();
    const win = new RouterTestWindow("/list/extra");
    const router = mod.start(root, win);
    await settle();
    expect(root.querySelector("a.go")?.classList.contains("on")).toBe(true);
    expect(root.querySelector("a.go")?.hasAttribute("aria-current")).toBe(false);
    router.dispose();
  });

  it("[LINK-32 I-A2] end makes only the exact location active", async () => {
    const mod = await linkPage(`<A to="/list" end activeClass="on" class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/list/extra"));
    await settle();
    expect(root.querySelector("a.go")?.classList.contains("on")).toBe(false);
    router.dispose();
  });

  it("[LINK-33 I-A2] the root link is active only at the root", async () => {
    const mod = await linkPage(`<A to="/" activeClass="on" class="go">home</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/list"));
    await settle();
    expect(root.querySelector("a.go")?.classList.contains("on")).toBe(false);
    router.dispose();
  });

  it("[LINK-34 I-A2] the active state follows the location after a navigation", async () => {
    const mod = await linkPage(`<A to="/list" activeClass="on" class="go">p</A>`);
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    expect(root.querySelector("a.go")?.classList.contains("on")).toBe(false);
    await router.navigate("/list");
    await settle();
    expect(root.querySelector("a.go")?.classList.contains("on")).toBe(true);
    router.dispose();
  });

  it("[LINK-35 I-A2] with a base path, the target and the location are compared without the base", async () => {
    const mod = await linkPage(`<A to="/list" activeClass="on" class="go">p</A>`);
    const root = host();
    const win = new RouterTestWindow("/app/list");
    const router = mod.start(root, win, { base: "/app" });
    await settle();
    expect(root.querySelector("a.go")?.getAttribute("href")).toBe("/app/list");
    expect(root.querySelector("a.go")?.classList.contains("on")).toBe(true);
    router.dispose();
  });

  it("[LINK-36 I-N13] a query-only target is resolved against the current pathname", async () => {
    const mod = await linkPage(`<A to="?page=3" class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/list?page=1"));
    await settle();
    expect(root.querySelector("a.go")?.getAttribute("href")).toBe("/list?page=3");
    router.dispose();
  });
});

describe("A: preload", () => {
  it("[LINK-40 I-A3] intent preload fires after 50 ms of hover", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const mod = await linkPage(`<A to="/list" class="go">p</A>`);
      const root = host();
      const router = mod.start(root, new RouterTestWindow("/"));
      await settle();
      const anchor = root.querySelector("a.go") as Element;
      anchor.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(49);
      await settle();
      expect(mod.preloads).toEqual(["home"]);
      vi.advanceTimersByTime(1);
      await settle();
      expect(mod.preloads).toEqual(["home", "list"]);
      router.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[LINK-41 I-A3] leaving the link before 50 ms cancels the preload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const mod = await linkPage(`<A to="/list" class="go">p</A>`);
      const root = host();
      const router = mod.start(root, new RouterTestWindow("/"));
      await settle();
      const anchor = root.querySelector("a.go") as Element;
      anchor.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(20);
      anchor.dispatchEvent(new MouseEvent("mouseleave"));
      vi.advanceTimersByTime(500);
      await settle();
      expect(mod.preloads).toEqual(["home"]);
      router.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[LINK-42 I-A3] focus preloads at once", async () => {
    const mod = await linkPage(`<A to="/list" class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    (root.querySelector("a.go") as Element).dispatchEvent(new FocusEvent("focus"));
    await settle();
    expect(mod.preloads).toContain("list");
    router.dispose();
  });

  it("[LINK-43 I-A3] touch preloads at once", async () => {
    const mod = await linkPage(`<A to="/list" class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    (root.querySelector("a.go") as Element).dispatchEvent(
      new Event("touchstart", { bubbles: true }),
    );
    await settle();
    expect(mod.preloads).toContain("list");
    router.dispose();
  });

  it("[LINK-44 I-A3] preload=false never preloads", async () => {
    const mod = await linkPage(`<A to="/list" preload={false} class="go">p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"));
    await settle();
    (root.querySelector("a.go") as Element).dispatchEvent(new FocusEvent("focus"));
    await settle();
    expect(mod.preloads).toEqual(["home"]);
    router.dispose();
  });

  it("[LINK-45 I-A3] preload=viewport preloads when the link becomes visible", async () => {
    let fire: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    class FakeObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        fire = callback;
      }
      observe(): void {
        // The test drives the callback directly.
      }
      disconnect(): void {
        fire = undefined;
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    try {
      const mod = await linkPage(`<A to="/list" preload="viewport" class="go">p</A>`);
      const root = host();
      const router = mod.start(root, new RouterTestWindow("/"));
      await settle();
      expect(mod.preloads).toEqual(["home"]);
      fire?.([{ isIntersecting: false }]);
      await settle();
      expect(mod.preloads).toEqual(["home"]);
      fire?.([{ isIntersecting: true }]);
      await settle();
      expect(mod.preloads).toEqual(["home", "list"]);
      router.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("A: caller handlers and explicit aria-current", () => {
  it("[LINK-14 I-A1] a caller onClick runs before the router, and the router still navigates", async () => {
    const mod = await linkPage(
      `<A to="/list" class="go" onClick={() => { globalThis.__clicks = (globalThis.__clicks ?? 0) + 1; }}>list</A>`,
    );
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    Reflect.deleteProperty(globalThis, "__clicks");
    const event = click(root.querySelector("a.go") as Element);
    await settle();
    expect(Reflect.get(globalThis, "__clicks")).toBe(1);
    expect(event.prevented).toBe(true);
    expect(win.location.pathname).toBe("/list");
    router.dispose();
  });

  it("[LINK-15 I-A1] a caller that calls preventDefault keeps the router from navigating", async () => {
    const mod = await linkPage(
      `<A to="/list" class="go" onClick={(event) => event.preventDefault()}>list</A>`,
    );
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win);
    await settle();
    click(root.querySelector("a.go") as Element);
    await settle();
    expect(win.location.pathname).toBe("/");
    router.dispose();
  });

  it("[LINK-37 I-A2] an explicit aria-current, even undefined, replaces the automatic one", async () => {
    const mod = await linkPage(`<A to="/list" class="go" aria-current={undefined}>p</A>`);
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/list"));
    await settle();
    expect(root.querySelector("a.go")?.hasAttribute("aria-current")).toBe(false);
    router.dispose();
  });
});
