import { describe, expect, it } from "vitest";
import { createBrowserHistory } from "../src/core/history";
import { canonicalizePathname, resolveSameOrigin } from "../src/core/index";
import { createLoaderCache } from "../src/core/loader-cache";
import { defineRoute, unsafeHref } from "../src/index";
import { deferred } from "./support/deferred";
import { createFakeClock } from "./support/fake-clock";
import { FakeWindow } from "./support/fake-window";
import { rig, settle } from "./support/rig";

/** Review round seven: defects of the core, found by reading the sources and confirmed by a test. */

const BASE = "https://app.test/";

describe("resolveSameOrigin: a dot or an empty segment never makes a protocol-relative result", () => {
  it.each(["/.//evil.com", "/..//x", "/%2e//x", "/a/..//x", "/./\\x", "/a/../\\x"])(
    "[RTR-R7-1] %s stays on the origin of the page",
    (target) => {
      const result = resolveSameOrigin(target, BASE);
      expect(result).toBeDefined();
      expect(result?.startsWith("//")).toBe(false);
      expect(new URL(result ?? "", BASE).origin).toBe("https://app.test");
    },
  );

  it("[RTR-R7-1] the collapsed path keeps the host-looking text as a path, and the query and fragment", () => {
    expect(resolveSameOrigin("/.//evil.com/x?a=1#h", BASE)).toBe("/evil.com/x?a=1#h");
  });

  it("[RTR-R7-1] unsafeHref refuses the shapes that resolve to a protocol-relative path", () => {
    expect(() => unsafeHref("/.//evil.com")).toThrow(TypeError);
    expect(() => unsafeHref("/a/..//x")).toThrow(TypeError);
    expect(() => unsafeHref("/%2e//x")).toThrow(TypeError);
    expect(unsafeHref("/a/b?x=1")).toBe("/a/b?x=1");
  });
});

describe("a trailing slash with a base path", () => {
  const routes = [defineRoute("/", {}), defineRoute("/posts", {})];

  it("[RTR-R7-4] always: every target, the root too, ends with a slash under the base", async () => {
    const r = rig(routes, { url: "/app/", base: "/app", trailingSlash: "always" });
    await r.router.ready();
    expect(r.router.href("/posts")).toBe("/app/posts/");
    expect(r.router.href("/")).toBe("/app/");
    await r.router.navigate("/posts");
    await settle();
    expect(r.win.location.pathname).toBe("/app/posts/");
    expect(r.router.state.location()?.pathname).toBe("/app/posts/");
    await r.router.navigate("/");
    await settle();
    expect(r.win.location.pathname).toBe("/app/");
    r.router.dispose();
  });

  it("[RTR-R7-4] preserve: the slash the caller wrote is kept, and one it did not write is not added", async () => {
    const r = rig(routes, { url: "/app", base: "/app", trailingSlash: "preserve" });
    await r.router.ready();
    await r.router.navigate("/posts/");
    await settle();
    expect(r.win.location.pathname).toBe("/app/posts/");
    await r.router.navigate("/posts");
    await settle();
    expect(r.win.location.pathname).toBe("/app/posts");
    r.router.dispose();
  });

  it("[RTR-R7-4] never: nothing ends with a slash under the base, the root included", async () => {
    const r = rig(routes, { url: "/app", base: "/app", trailingSlash: "never" });
    await r.router.ready();
    expect(r.router.href("/posts/")).toBe("/app/posts");
    expect(r.router.href("/")).toBe("/app");
    r.router.dispose();
  });
});

describe("a malformed path commits like an unmatched path", () => {
  const routes = [
    defineRoute("", {
      id: "shell",
      notFound: () => "root not found",
      children: [defineRoute("/", { id: "home" })],
    }),
  ];

  it.each(["/%zz", "/a//b"])(
    "[RTR-R7-5] navigate(%s) updates the URL and resolves notFound",
    async (to) => {
      const r = rig(routes);
      await r.router.ready();
      const outcome = await r.router.navigate(to);
      await settle();
      expect(outcome.kind).toBe("notFound");
      expect(r.win.location.pathname).toBe(to);
      expect(r.router.state.location()?.pathname).toBe(to);
      expect(r.router.state.matches().map((match) => match.kind)).toEqual(["route", "notFound"]);
      r.router.dispose();
    },
  );

  it.each(["/%zz", "/a//b"])("[RTR-R7-5] landing on %s shows the not-found route", async (url) => {
    const r = rig(routes, { url });
    await r.router.ready();
    expect(r.router.state.matches().map((match) => match.kind)).toEqual(["route", "notFound"]);
    r.router.dispose();
  });

  it("[RTR-R7-5] under a base path the malformed target stays under the base", async () => {
    const r = rig(routes, { url: "/app", base: "/app" });
    await r.router.ready();
    await r.router.navigate("/%zz");
    await settle();
    expect(r.win.location.pathname).toBe("/app/%zz");
    r.router.dispose();
  });
});

describe("history: a native fragment navigation", () => {
  it("[RTR-R7-6] gets its own index, so Back returns to the page before it", () => {
    const win = new FakeWindow("/one", null);
    const history = createBrowserHistory(win, { scheduleFlush: (run) => run() });
    history.push("/two");
    expect(history.location.index).toBe(1);
    // The browser pushes an entry for <a href="#x"> and fires popstate; the router did not write it.
    win.writeEntry(false, null, "/two#x");
    win.queueGo(0);
    win.runAllTraversals();
    expect(history.location.pathname).toBe("/two");
    expect(history.location.hash).toBe("#x");
    expect(history.location.index).toBe(2);
    win.queueGo(-1);
    win.runAllTraversals();
    expect(history.location.hash).toBe("");
    expect(history.location.index).toBe(1);
    expect(win.location.hash).toBe("");
    win.queueGo(1);
    win.runAllTraversals();
    expect(history.location.hash).toBe("#x");
    expect(history.location.index).toBe(2);
    history.destroy();
  });
});

describe("invalidate and reload yield to a navigation in flight", () => {
  it("[RTR-R7-7] invalidate() while navigate() is pending does not cancel the navigation", async () => {
    const gate = deferred<string>();
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/slow", { id: "slow", loader: () => gate.promise }),
    ]);
    await r.router.ready();
    const navigation = r.router.navigate("/slow");
    await settle();
    const invalidation = r.router.invalidate();
    await settle();
    gate.resolve("slow data");
    const outcome = await navigation;
    const reloaded = await invalidation;
    await settle();
    expect(outcome.kind).toBe("success");
    expect(reloaded.kind).toBe("success");
    expect(r.router.state.location()?.pathname).toBe("/slow");
    expect(r.win.location.pathname).toBe("/slow");
    r.router.dispose();
  });

  it("[RTR-R7-7] with no navigation in flight, invalidate() reloads at once", async () => {
    let calls = 0;
    const r = rig([defineRoute("/", { id: "home", loader: () => ++calls })]);
    await r.router.ready();
    const outcome = await r.router.invalidate();
    expect(outcome.kind).toBe("success");
    expect(calls).toBe(2);
    r.router.dispose();
  });
});

describe("encoding", () => {
  it("[RTR-R7-8] a byte order mark inside a path segment survives canonicalization", () => {
    expect(canonicalizePathname("/%EF%BB%BF")).toBe("/%EF%BB%BF");
    expect(canonicalizePathname("/a%EF%BB%BFb")).toBe("/a%EF%BB%BFb");
  });
});

describe("loader cache: seeded data from a clock that is ahead", () => {
  it("[RTR-R7-9] a seed dated in the future is not fresh for longer than staleTime", () => {
    const clock = createFakeClock(1_000);
    const cache = createLoaderCache({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      staleTime: 100,
    });
    cache.seed({ routeId: "post", params: { id: "1" }, value: "server", updatedAt: 10_000_000 });
    expect(cache.peek("post", { id: "1" })?.updatedAt).toBe(1_000);
    expect(cache.peek("post", { id: "1" })?.stale).toBe(false);
    clock.advance(100);
    expect(cache.peek("post", { id: "1" })?.stale).toBe(true);
  });
});
