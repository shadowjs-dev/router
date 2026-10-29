import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { RouterTestWindow } from "./support/router-window";

interface SearchModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    maxSearchLength: number,
  ): { navigate(to: string): Promise<unknown>; dispose(): void; errors: unknown[] };
}

const SOURCE = `
  import { createRouter, defineRoute, RouterProvider, Outlet, useSearchParams } from "@router";
  import { render } from "@shadow-js/web";

  const page = defineRoute("/", {
    id: "page",
    component: function Page() {
      const [params] = useSearchParams();
      return <p class="size">{String(String(params().q).length)}</p>;
    },
  });

  export function start(host, win, maxSearchLength) {
    const errors = [];
    const router = createRouter({ routes: [page], window: win, maxSearchLength, onError: (e) => errors.push(e) });
    const stop = render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return {
      navigate: (to) => router.navigate(to),
      dispose() { stop(); router.dispose(); },
      errors,
    };
  }
`;

interface LinkModule {
  start(host: HTMLElement, win: RouterTestWindow, caseSensitive: boolean): { dispose(): void };
}

const LINKS = `
  import { createRouter, defineRoute, RouterProvider, Outlet, A } from "@router";
  import { render } from "@shadow-js/web";

  const about = defineRoute("/about", {
    id: "about",
    component: () => <nav><A to="/about" activeClass="on">About</A></nav>,
  });

  export function start(host, win, caseSensitive) {
    const router = createRouter({ routes: [about], window: win, caseSensitive });
    const stop = render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return { dispose() { stop(); router.dispose(); } };
  }
`;

describe("router review: hooks", () => {
  it("[RTR-REV-8] useSearchParams reads a query up to the router's maxSearchLength, not the 4096 default", async () => {
    const mod = await load<SearchModule>(SOURCE);
    const root = host();
    const query = "x".repeat(5000);
    const app = mod.start(root, new RouterTestWindow(`/?q=${query}`), 8000);
    await settle();
    expect(app.errors).toEqual([]);
    expect(root.querySelector(".size")?.textContent).toBe("5000");
    app.dispose();
  });

  it("[RTR-REV-11] a link is active at the same page written in another case when the router ignores case", async () => {
    const mod = await load<LinkModule>(LINKS);
    const root = host();
    const app = mod.start(root, new RouterTestWindow("/About"), false);
    await settle();
    const anchor = root.querySelector("a");
    expect(anchor?.getAttribute("aria-current")).toBe("page");
    expect(anchor?.classList.contains("on")).toBe(true);
    app.dispose();
  });
});
