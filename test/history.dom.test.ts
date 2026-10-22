import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { RouterTestWindow } from "./support/router-window";

interface Blocker {
  status(): string;
  transition(): { action: string; pathname: string } | undefined;
  proceed(): void;
  reset(): void;
}

interface Flags {
  dirty: boolean;
  leavePrevent: boolean;
}

interface HistoryModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    flags: Flags,
  ): {
    router: {
      navigate(to: string, options?: unknown): Promise<{ kind: string }>;
      history: { location: { index: number; pathname: string }; go(delta: number): void };
      state: { location(): { pathname: string } | undefined };
      dispose(): void;
    };
    readonly blocker: Blocker | null;
    seen: string[];
    dispose(): void;
  };
}

/** Three pages under a shell whose `Guard` holds a blocker and a before-leave listener. */
const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet } from "@router";
  import { blockers, useBlocker, useBeforeLeave } from "@router/blockers";
  import { render } from "@shadow-js/web";

  export const seen = [];
  let blocker = null;
  let flags = { dirty: false, leavePrevent: false };
  function Guard() {
    blocker = useBlocker(() => flags.dirty);
    useBeforeLeave((event) => { seen.push(event.transition.action); if (flags.leavePrevent) event.preventDefault(); });
    return null;
  }
  const pages = ["a", "b", "c"].map((name) => defineRoute("/" + name, { id: name, component: () => <p class="page">{name}</p> }));
  const shell = defineRoute("", { id: "shell", component: () => <div><Guard /><Outlet /></div>, children: pages });
  export function start(host, win, next) {
    flags = next;
    const router = createRouter({ routes: [shell], window: win, features: [blockers()] });
    const dispose = render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return {
      router,
      dispose,
      seen,
      get blocker() { return blocker; },
    };
  }
`;

async function app(): Promise<HistoryModule> {
  return load<HistoryModule>(APP);
}

/** Starts the app on `/a` and lets the shell render. */
async function boot(
  flags: Flags,
  url: string = "/a",
): Promise<{
  mod: HistoryModule;
  root: HTMLElement;
  win: RouterTestWindow;
  app: ReturnType<HistoryModule["start"]>;
}> {
  const mod = await app();
  const root = host();
  const win = new RouterTestWindow(url);
  const started = mod.start(root, win, flags);
  await settle();
  return { mod, root, win, app: started };
}

describe("history: traversal", () => {
  it("[HIST-01 I-N9] back and forward move the location through the browser history", async () => {
    const { win, app: started } = await boot({ dirty: false, leavePrevent: false });
    const router = started.router;
    await router.navigate("/b");
    await router.navigate("/c");
    await settle();
    router.history.go(-1);
    win.runAllTraversals();
    await settle();
    expect(router.state.location()?.pathname).toBe("/b");
    router.history.go(-1);
    win.runAllTraversals();
    await settle();
    expect(router.state.location()?.pathname).toBe("/a");
    router.dispose();
  });

  it("[HIST-02 I-N9] the screen follows a traversal", async () => {
    const { root, win, app: started } = await boot({ dirty: false, leavePrevent: false });
    await started.router.navigate("/b");
    await settle();
    started.router.history.go(-1);
    win.runAllTraversals();
    await settle();
    expect(root.querySelector(".page")?.textContent).toBe("a");
    started.router.dispose();
  });

  it("[HIST-03 I-N7] the history index counts every push, and a long traversal lands on the right index", async () => {
    const { win, app: started } = await boot({ dirty: false, leavePrevent: false });
    const router = started.router;
    for (let n = 0; n < 70; n += 1) await router.navigate(n % 2 === 0 ? "/b" : "/c");
    expect(router.history.location.index).toBe(70);
    router.history.go(-60);
    win.runAllTraversals();
    await settle();
    expect(router.history.location.index).toBe(10);
    expect(win.position).toBe(10);
    router.dispose();
  });
});

describe("history: blockers", () => {
  it("[HIST-10 I-N9] a blocked push resolves as blocked and leaves the location alone", async () => {
    const { app: started } = await boot({ dirty: true, leavePrevent: false });
    const outcome = await started.router.navigate("/b");
    expect(outcome.kind).toBe("blocked");
    expect(started.router.state.location()?.pathname).toBe("/a");
    expect(started.blocker?.status()).toBe("blocked");
    expect(started.blocker?.transition()?.action).toBe("PUSH");
    started.router.dispose();
  });

  it("[HIST-11 I-N9] proceed() lets the held push through", async () => {
    const { app: started } = await boot({ dirty: true, leavePrevent: false });
    await started.router.navigate("/b");
    started.blocker?.proceed();
    await settle();
    expect(started.router.state.location()?.pathname).toBe("/b");
    expect(started.blocker?.status()).toBe("idle");
    started.router.dispose();
  });

  it("[HIST-12 I-N9] reset() drops the held push", async () => {
    const { app: started } = await boot({ dirty: true, leavePrevent: false });
    await started.router.navigate("/b");
    started.blocker?.reset();
    await settle();
    expect(started.router.state.location()?.pathname).toBe("/a");
    expect(started.blocker?.status()).toBe("idle");
    started.router.dispose();
  });

  it("[HIST-14 I-N9] a blocked back traversal is reverted and the screen stays; proceed() re-issues it", async () => {
    const flags = { dirty: false, leavePrevent: false };
    const { win, app: started } = await boot(flags);
    const router = started.router;
    await router.navigate("/b");
    await settle();
    flags.dirty = true;
    const positionBefore = win.position;
    router.history.go(-1);
    win.runAllTraversals();
    await settle();
    expect(win.position).toBe(positionBefore);
    expect(router.state.location()?.pathname).toBe("/b");
    expect(started.blocker?.status()).toBe("blocked");
    started.blocker?.proceed();
    win.runAllTraversals();
    await settle();
    expect(router.state.location()?.pathname).toBe("/a");
    expect(win.position).toBe(positionBefore - 1);
    router.dispose();
  });

  it("[HIST-15 I-N9] several fast back clicks while the prompt is open leave the stacks in step", async () => {
    const flags = { dirty: false, leavePrevent: false };
    const { win, app: started } = await boot(flags);
    const router = started.router;
    await router.navigate("/b");
    await router.navigate("/c");
    await settle();
    flags.dirty = true;
    router.history.go(-1);
    router.history.go(-1);
    win.runAllTraversals();
    await settle();
    expect(router.state.location()?.pathname).toBe("/c");
    expect(win.location.pathname).toBe("/c");
    started.blocker?.reset();
    await settle();
    expect(router.history.location.index).toBe(win.position);
    router.dispose();
  });

  it("[HIST-16 I-N10] useBeforeLeave with preventDefault keeps the user where they are", async () => {
    const { app: started } = await boot({ dirty: false, leavePrevent: true });
    await started.router.navigate("/b");
    await settle();
    expect(started.router.state.location()?.pathname).toBe("/a");
    expect(started.seen).toContain("PUSH");
    started.router.dispose();
  });

  it("[HIST-17 I-N10] useBeforeLeave without preventDefault lets the navigation through", async () => {
    const { app: started } = await boot({ dirty: false, leavePrevent: false });
    await started.router.navigate("/b");
    await settle();
    expect(started.router.state.location()?.pathname).toBe("/b");
    expect(started.seen).toContain("PUSH");
    started.router.dispose();
  });

  it("[HIST-18 I-N10] a blocker holds while a before-leave listener allows the same transition", async () => {
    const { app: started } = await boot({ dirty: true, leavePrevent: false });
    const outcome = await started.router.navigate("/b");
    expect(outcome.kind).toBe("blocked");
    expect(started.seen).toContain("PUSH");
    started.router.dispose();
  });

  it("[HIST-19 I-N10] unmounting the component removes its guards, so navigation is allowed again", async () => {
    const { app: started } = await boot({ dirty: true, leavePrevent: true });
    started.dispose();
    const outcome = await started.router.navigate("/b");
    expect(outcome.kind).toBe("success");
    expect(started.router.state.location()?.pathname).toBe("/b");
    started.router.dispose();
  });
});

describe("history: writes", () => {
  it("[HIST-20 I-N12] navigating to the current location with the same state is a no-op", async () => {
    const { win, app: started } = await boot({ dirty: false, leavePrevent: false });
    const before = win.entryCount;
    await started.router.navigate("/a");
    expect(win.entryCount).toBe(before);
    started.router.dispose();
  });

  it("[HIST-21 I-N12] a same-URL navigation with new state replaces the entry", async () => {
    const { win, app: started } = await boot({ dirty: false, leavePrevent: false });
    const before = win.entryCount;
    await started.router.navigate("/a", { state: { tab: 2 } });
    expect(win.entryCount).toBe(before);
    expect(win.currentState()).toMatchObject({ __shadowState: { tab: 2 } });
    started.router.dispose();
  });

  it("[HIST-22 I-N8] a replace that supersedes an unfinished push leaves one entry, at the replacing target", async () => {
    const { win, app: started } = await boot({ dirty: false, leavePrevent: false });
    const before = win.entryCount;
    const first = started.router.navigate("/b");
    const second = started.router.navigate("/c", { replace: true });
    await Promise.all([first, second]);
    await settle();
    expect(started.router.state.location()?.pathname).toBe("/c");
    expect(win.entryCount).toBe(before);
    started.router.dispose();
  });
});
