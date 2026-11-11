/** Findings of the router-data audit: each test asserts what a user sees. */
import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { RouterTestWindow } from "./support/router-window";

interface LinkModule {
  start(host: HTMLElement, win: RouterTestWindow): { readonly seen: string[]; dispose(): void };
}

async function linkPage(links: string): Promise<LinkModule> {
  return load<LinkModule>(`
    import { createRouter, defineRoute, RouterProvider, Outlet, A } from "@router";
    import { render } from "@shadow-js/web";
    const seen = [];
    const home = defineRoute("/", { id: "home", component: () => <div>${links}</div> });
    const list = defineRoute("/list", { id: "list", component: () => <p>list</p> });
    export function start(host, win) {
      const router = createRouter({ routes: [home, list], window: win, base: "", clock: undefined });
      render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
      return { seen, dispose: () => router.dispose() };
    }
  `);
}

describe("A forwards the caller's own event handlers", () => {
  it("[RTR-A1] onMouseEnter, onMouseLeave and onFocus given to <A> run, next to the router's preload handlers", async () => {
    const mod = await linkPage(
      `<A to="/list" class="go" onMouseEnter={() => seen.push("enter")} onMouseLeave={() => seen.push("leave")} onFocus={() => seen.push("focus")}>list</A>`,
    );
    const root = host();
    const win = new RouterTestWindow("/");
    const app = mod.start(root, win);
    await settle();
    const anchor = root.querySelector("a.go") as Element;
    anchor.dispatchEvent(new MouseEvent("mouseenter"));
    anchor.dispatchEvent(new MouseEvent("mouseleave"));
    anchor.dispatchEvent(new FocusEvent("focus"));
    expect(app.seen).toEqual(["enter", "leave", "focus"]);
    app.dispose();
  });
});

describe("A runs an onClick given as a listener object", () => {
  it("[RTR-A2] a listener object handles the click first, and the router still navigates", async () => {
    const mod = await linkPage(
      `<A to="/list" class="go" onClick={{ handleEvent(event) { seen.push(this.name + ":" + event.type); }, name: "obj" }}>list</A>`,
    );
    const root = host();
    const win = new RouterTestWindow("/");
    const app = mod.start(root, win);
    await settle();
    (root.querySelector("a.go") as Element).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    await settle();
    expect(app.seen).toEqual(["obj:click"]);
    expect(win.location.pathname).toBe("/list");
    app.dispose();
  });
});
