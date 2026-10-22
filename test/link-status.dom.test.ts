import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

interface LinkRouter {
  dispose(): void;
}

interface LinkStatusModule {
  start(host: HTMLElement, win: RouterTestWindow, clock: unknown, withStatus: boolean): LinkRouter;
  gate: { release: (() => void) | undefined };
}

// A layout that stays on screen holds two links. The `slow` page's loader waits until the test releases it, so its
// navigation stays pending; `fast` has no loader and commits at once. Each link's content shows its own pending
// state through `useLinkPending()`, and a `Pending` outside any link shows nothing pending.
const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet, A } from "@router";
  import { linkStatus, useLinkPending } from "@router/link-status";
  import { loaderCache } from "@router/loaders";
  import { render } from "@shadow-js/web";

  export const gate = { release: undefined };

  function Pending() {
    const link = useLinkPending();
    return <span class="pending">{link.pending ? "pending" : "idle"}</span>;
  }

  const shell = defineRoute("", {
    id: "shell",
    component: () => (
      <main>
        <nav>
          <A to="/slow" class="slow"><Pending /> slow</A>
          <A to="/fast" class="fast"><Pending /> fast</A>
        </nav>
        <span class="outside"><Pending /></span>
        <Outlet />
      </main>
    ),
    children: [
      defineRoute("/", { id: "home", component: () => <p class="home">home</p> }),
      defineRoute("/slow", {
        id: "slow-page",
        loader: () => new Promise((resolve) => { gate.release = () => resolve("slow data"); }),
        component: () => <p class="slow-page">slow page</p>,
      }),
      defineRoute("/fast", { id: "fast-page", component: () => <p class="fast-page">fast page</p> }),
    ],
  });

  export function start(host, win, clock, withStatus) {
    const router = createRouter({
      features: withStatus ? [loaderCache(), linkStatus()] : [loaderCache()],
      routes: [shell],
      window: win,
      clock,
    });
    const stop = render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    const disposeRouter = router.dispose;
    router.dispose = () => { disposeRouter(); stop(); };
    return router;
  }
`;

async function app(): Promise<LinkStatusModule> {
  return load<LinkStatusModule>(APP);
}

/** The pending text of the link with this class (or of the stray Pending outside links). */
function pendingOf(selector: string): string | null | undefined {
  return document.querySelector(`${selector} .pending`)?.textContent;
}

describe("link status: pending state of a link's navigation", () => {
  it("[LNK-01] a click makes its own link pending until the navigation commits, and clears it on commit", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), true);
    await settle();
    expect(pendingOf(".slow")).toBe("idle");
    (document.querySelector(".slow") as HTMLAnchorElement).click();
    await settle();
    expect(pendingOf(".slow")).toBe("pending");
    expect(pendingOf(".fast")).toBe("idle");
    expect(document.querySelector(".slow-page")).toBeNull();
    mod.gate.release?.();
    await settle();
    expect(document.querySelector(".slow-page")?.textContent).toBe("slow page");
    expect(pendingOf(".slow")).toBe("idle");
    router.dispose();
  });

  it("[LNK-02] only the last clicked link is pending: a newer click clears the earlier link", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), true);
    await settle();
    (document.querySelector(".slow") as HTMLAnchorElement).click();
    await settle();
    expect(pendingOf(".slow")).toBe("pending");
    (document.querySelector(".fast") as HTMLAnchorElement).click();
    await settle();
    expect(pendingOf(".slow")).toBe("idle");
    expect(pendingOf(".fast")).toBe("idle");
    expect(document.querySelector(".fast-page")?.textContent).toBe("fast page");
    router.dispose();
  });

  it("[LNK-03] without the feature no link reports pending, and the links still navigate", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), false);
    await settle();
    (document.querySelector(".slow") as HTMLAnchorElement).click();
    await settle();
    expect(pendingOf(".slow")).toBe("idle");
    expect(pendingOf(".outside")).toBe("idle");
    (document.querySelector(".fast") as HTMLAnchorElement).click();
    await settle();
    expect(document.querySelector(".fast-page")?.textContent).toBe("fast page");
    router.dispose();
  });

  it("[LNK-04] outside any link the pending state is always false, even while a link is pending", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/"), createFakeClock(0), true);
    await settle();
    (document.querySelector(".slow") as HTMLAnchorElement).click();
    await settle();
    expect(pendingOf(".slow")).toBe("pending");
    expect(pendingOf(".outside")).toBe("idle");
    mod.gate.release?.();
    await settle();
    router.dispose();
  });
});
