import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

interface AnnouncerRouter {
  navigate(to: string, options?: { readonly replace?: boolean }): Promise<unknown>;
  readonly history: { back(): void };
  dispose(): void;
}

/** Options of the announcer feature, as an app passes them (`routeAnnouncer(options)`). */
interface AnnouncerOptions {
  readonly fallback?: string | ((path: string) => string);
}

interface AnnouncerModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    clock: unknown,
    announcer?: AnnouncerOptions,
  ): AnnouncerRouter;
}

// Routes with a title (head), a main landmark holding an h1, and a fragment target. A route with no
// title and no heading, and one with a heading outside its main landmark, cover the fallbacks. The
// announcer is the feature under test; every other default feature is present so the router behaves as it does in an app.
const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
  import { routeAnnouncer } from "@router/announcer";
  import { render } from "@shadow-js/web";
  export const home = defineRoute("/", {
    id: "home",
    head: () => ({ tag: "title", children: "Home page" }),
    component: () => <main><h1>Home</h1></main>,
  });
  export const about = defineRoute("/about", {
    id: "about",
    head: () => ({ tag: "title", children: "About us" }),
    component: () => <main><h1>About</h1><section id="team"><p>The team.</p></section></main>,
  });
  export const bare = defineRoute("/bare/page", {
    id: "bare",
    component: () => <main><p>A long paragraph of body text that is not a heading.</p></main>,
  });
  export const outsideHeading = defineRoute("/outside", {
    id: "outside",
    component: () => <div><h1>Shown in the header</h1><main><p>Body text.</p></main></div>,
  });
  export function start(host, win, clock, announcer) {
    const router = createRouter({
      features: [...everyFeature(), routeAnnouncer(announcer)],
      routes: [home, about, bare, outsideHeading],
      window: win,
      clock,
    });
    const stop = render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    // The rendered tree owns the page's head (a title it set is removed with it): a test disposes both.
    const disposeRouter = router.dispose;
    router.dispose = () => { disposeRouter(); stop(); };
    return router;
  }
`;

async function app(): Promise<AnnouncerModule> {
  return load<AnnouncerModule>(APP);
}

/** The live region the announcer adds: a polite, atomic status. */
function liveRegion(): Element | null {
  return document.querySelector('[role="status"][aria-live="polite"][aria-atomic="true"]');
}

/** A control outside the app, focused before a navigation so a test can see whether focus moved. */
function outsideButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "outside";
  document.body.appendChild(button);
  button.focus();
  return button;
}

describe("route announcer", () => {
  it("[ANN-01 2.4.2] a client navigation makes the live region announce the new page title", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0));
    await settle();
    await router.navigate("/about");
    await settle();
    expect(liveRegion()).not.toBeNull();
    expect(liveRegion()?.textContent).toBe("About us");
    expect(document.title).toBe("About us");
    router.dispose();
  });

  it("[ANN-02 2.4.3] a client navigation moves focus to the new page heading", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0));
    await settle();
    outsideButton();
    await router.navigate("/about");
    await settle();
    const heading = document.querySelector("h1");
    expect(heading?.textContent).toBe("About");
    expect(heading?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
    router.dispose();
  });

  it("[ANN-03 4.1.3] the first load neither announces nor moves focus", async () => {
    const mod = await app();
    const root = host();
    const button = outsideButton();
    const router = mod.start(root, new RouterTestWindow("/about"), createFakeClock(0));
    await settle();
    expect(document.title).toBe("About us");
    expect(liveRegion()?.textContent).toBe("");
    expect(document.activeElement).toBe(button);
    router.dispose();
  });

  it("[ANN-04 2.4.3] a hash-only change and a repeated URL neither move focus nor announce", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0));
    await settle();
    await router.navigate("/about");
    await settle();
    const button = outsideButton();
    await router.navigate("/about#team");
    await settle();
    expect(document.activeElement).toBe(button);
    await router.navigate("/about#team");
    await settle();
    expect(document.activeElement).toBe(button);
    expect(liveRegion()?.textContent).toBe("About us");
    router.dispose();
  });

  it("[ANN-07] a replace that only adds or drops the trailing slash of the same page is not a navigation", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/about/"), createFakeClock(0));
    await settle();
    const button = outsideButton();
    await router.navigate("/about", { replace: true });
    await settle();
    expect(document.activeElement).toBe(button);
    expect(liveRegion()?.textContent).toBe("");
    router.dispose();
  });

  it("[ANN-05 2.4.3] a back navigation also moves focus to the page heading and announces it", async () => {
    const mod = await app();
    const root = host();
    const win = new RouterTestWindow("/");
    const router = mod.start(root, win, createFakeClock(0));
    await settle();
    await router.navigate("/about");
    await settle();
    outsideButton();
    router.history.back();
    // The fake window queues the traversal; running it delivers the popstate, as a browser does.
    win.runNextTraversal();
    await settle();
    expect(liveRegion()?.textContent).toBe("Home page");
    expect(document.activeElement?.textContent).toBe("Home");
    router.dispose();
  });

  it("[ANN-06] dispose removes the live region from the document", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0));
    await settle();
    expect(liveRegion()).not.toBeNull();
    router.dispose();
    expect(liveRegion()).toBeNull();
  });

  it("[ANN-08 2.4.3] a push to a hash of another page focuses the target element, not the heading, and the target drops its temporary tabindex on blur", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0));
    await settle();
    outsideButton();
    await router.navigate("/about#team");
    await settle();
    const team = document.getElementById("team");
    expect(team).not.toBeNull();
    expect(document.activeElement).toBe(team);
    expect(team?.getAttribute("tabindex")).toBe("-1");
    expect(liveRegion()?.textContent).toBe("About us");
    const other = outsideButton();
    await settle();
    expect(document.activeElement).toBe(other);
    expect(team?.hasAttribute("tabindex")).toBe(false);
    router.dispose();
  });

  it("[ANN-09 2.4.2] a page with no title and no heading announces its URL path, never the text of its main content", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0));
    await settle();
    document.title = "";
    outsideButton();
    await router.navigate("/bare/page");
    await settle();
    expect(liveRegion()?.textContent).toBe("/bare/page");
    expect(liveRegion()?.textContent).not.toContain("paragraph");
    expect(document.activeElement?.tagName).toBe("MAIN");
    router.dispose();
  });

  it("[ANN-10 2.4.2] with no title, the first heading of the document is announced even when it is outside main", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0));
    await settle();
    document.title = "";
    outsideButton();
    await router.navigate("/outside");
    await settle();
    expect(liveRegion()?.textContent).toBe("Shown in the header");
    router.dispose();
  });

  it("[ANN-11 2.4.2] the fallback option formats the label of a page with no title and no heading", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), {
      fallback: (path: string) => `Navigated to ${path}`,
    });
    await settle();
    document.title = "";
    await router.navigate("/bare/page");
    await settle();
    expect(liveRegion()?.textContent).toBe("Navigated to /bare/page");
    router.dispose();
  });

  it("[ANN-12 2.4.2] a string fallback is announced as it is written", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), {
      fallback: "New page",
    });
    await settle();
    document.title = "";
    await router.navigate("/bare/page");
    await settle();
    expect(liveRegion()?.textContent).toBe("New page");
    router.dispose();
  });
});
