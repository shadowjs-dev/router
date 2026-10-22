import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  decodeHash,
  type History,
  type HistoryUpdate,
  type Transition,
} from "../../src/core/history";
import { FakeWindow } from "../support/fake-window";

const PROPS = { seed: 5, numRuns: 300 } as const;

/** Flushes a synchronous scheduler so each write is applied at once (no microtask needed). */
const syncFlush = { scheduleFlush: (run: () => void): void => run() } as const;

function pathnames(history: History): string {
  return `${history.location.pathname}${history.location.search}${history.location.hash}`;
}

function collect(history: History): HistoryUpdate[] {
  const updates: HistoryUpdate[] = [];
  history.listen((update) => {
    updates.push(update);
  });
  return updates;
}

describe("memory history: stack and index", () => {
  it("[I-N7] keeps an owned index over more than 60 entries", () => {
    const history = createMemoryHistory({ initialEntries: ["/p0"], ...syncFlush });
    for (let step = 1; step <= 70; step += 1) history.push(`/p${step}`);
    expect(history.location.index).toBe(70);
    expect(history.length).toBe(71);
    for (let step = 0; step < 60; step += 1) history.back();
    expect(history.location.index).toBe(10);
    expect(history.location.pathname).toBe("/p10");
  });

  it("[I-N7] forward moves to the next entry and back to the first", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b", "/c"], ...syncFlush });
    history.back();
    history.back();
    expect(history.location.pathname).toBe("/a");
    history.forward();
    expect(history.location.pathname).toBe("/b");
  });

  it("push drops the forward entries", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b", "/c"], ...syncFlush });
    history.back();
    history.push("/x");
    expect(history.length).toBe(3);
    history.forward();
    expect(history.location.pathname).toBe("/x");
  });

  it("replace keeps the index and the length", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    history.replace("/b");
    expect(history.location.pathname).toBe("/b");
    expect(history.location.index).toBe(0);
    expect(history.length).toBe(1);
  });

  it.each([
    ["/users/5", "/users/5"],
    ["posts", "/users/posts"],
    ["../posts", "/posts"],
    ["./x/../y", "/users/y"],
    ["/abs/?", "/abs/"],
    ["a/b/..", "/users/a/"],
  ])("[I-N13] resolves %j from /users/5/ as %j when based at /users/5", (to, expected) => {
    const history = createMemoryHistory({ initialEntries: ["/users/5"], ...syncFlush });
    history.push(to);
    expect(history.location.pathname).toBe(expected);
  });

  it("[I-N13] a query-only target keeps the current pathname", () => {
    const history = createMemoryHistory({ initialEntries: ["/users/5"], ...syncFlush });
    history.push("?tab=2");
    expect(history.location.pathname).toBe("/users/5");
    expect(history.location.search).toBe("?tab=2");
  });

  it("a hash-only target keeps the current path and query", () => {
    const history = createMemoryHistory({ initialEntries: ["/a?x=1"], ...syncFlush });
    history.push("#section");
    expect(history.location.pathname).toBe("/a");
    expect(history.location.search).toBe("?x=1");
    expect(history.location.hash).toBe("#section");
  });

  it("an empty query or hash marker is dropped", () => {
    const history = createMemoryHistory({ initialEntries: ["/a?x=1#h"], ...syncFlush });
    history.push("/b?#");
    expect(history.location.search).toBe("");
    expect(history.location.hash).toBe("");
  });

  it("[I-U10] an unsafe target throws TypeError and changes nothing", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    expect(() => history.push("javascript:alert(1)")).toThrow(TypeError);
    expect(() => history.replace("java\tscript:alert(1)")).toThrow(TypeError);
    expect(history.location.pathname).toBe("/a");
  });

  it("[I-U2] a protocol-relative target stays on this origin", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    history.push("//evil.example/x");
    expect(history.location.pathname).toBe("/evil.example/x");
  });

  it("[I-U12] decodeHash never throws and keeps malformed escapes literal", () => {
    expect(decodeHash("#%")).toBe("%");
    expect(decodeHash("#a%20b")).toBe("a b");
    expect(decodeHash("")).toBe("");
    expect(decodeHash("#%E4%BD%A0")).toBe("你");
  });

  it("the state is stored with the entry and returned on traversal", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    history.push("/b", { scroll: 40 });
    history.back();
    expect(history.location.state).toBeUndefined();
    history.forward();
    expect(history.location.state).toEqual({ scroll: 40 });
  });

  it("[I-N12] the same URL with the same state is a no-op that emits nothing", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const updates = collect(history);
    expect(history.push("/a")).toBe(true);
    expect(history.length).toBe(1);
    expect(updates).toEqual([]);
  });

  it("[I-N12] the same URL with a new state replaces the state", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const updates = collect(history);
    history.push("/a", { tab: 2 });
    expect(history.length).toBe(1);
    expect(history.location.state).toEqual({ tab: 2 });
    expect(updates.map((update) => update.action)).toEqual(["REPLACE"]);
  });

  it("go(0) and out-of-range traversals do nothing", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b"], ...syncFlush });
    const updates = collect(history);
    history.go(0);
    history.go(5);
    history.go(-5);
    expect(history.location.pathname).toBe("/b");
    expect(updates).toEqual([]);
  });

  it("an initialIndex selects the starting entry", () => {
    const history = createMemoryHistory({
      initialEntries: ["/a", "/b", "/c"],
      initialIndex: 0,
      ...syncFlush,
    });
    expect(history.location.pathname).toBe("/a");
    expect(() => createMemoryHistory({ initialEntries: ["/a"], initialIndex: 3 })).toThrow(
      RangeError,
    );
  });

  it("listeners receive every committed change and can unsubscribe", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const updates: HistoryUpdate[] = [];
    const stop = history.listen((update) => {
      updates.push(update);
    });
    history.push("/b");
    history.back();
    stop();
    history.push("/c");
    expect(updates.map((update) => [update.action, update.location.pathname])).toEqual([
      ["PUSH", "/b"],
      ["POP", "/a"],
    ]);
  });

  it("a listener that throws does not stop the others, and the failure is rethrown", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const seen: string[] = [];
    history.listen(() => {
      throw new Error("boom");
    });
    history.listen((update) => {
      seen.push(update.location.pathname);
    });
    expect(() => history.push("/b")).toThrow("boom");
    expect(seen).toEqual(["/b"]);
    expect(history.location.pathname).toBe("/b");
  });

  it("destroy stops further navigation and listener calls", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const updates = collect(history);
    history.destroy();
    expect(history.push("/b")).toBe(false);
    expect(updates).toEqual([]);
  });
});

describe("memory history: batched writes", () => {
  it("[I-N8] push then replace in one tick is one pushed entry with the replaced URL", async () => {
    const history = createMemoryHistory({ initialEntries: ["/a"] });
    history.push("/b");
    history.replace("/c");
    expect(history.location.pathname).toBe("/c");
    expect(history.length).toBe(1);
    await Promise.resolve();
    expect(history.length).toBe(2);
    history.back();
    expect(history.location.pathname).toBe("/a");
    history.forward();
    expect(history.location.pathname).toBe("/c");
  });

  it("[I-N8] two pushes in one tick are two entries", async () => {
    const history = createMemoryHistory({ initialEntries: ["/a"] });
    history.push("/b");
    history.push("/c");
    history.flush();
    expect(history.length).toBe(3);
  });

  it("[I-N8] replace then push in one tick replaces the current entry and then pushes", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"] });
    history.replace("/x");
    history.push("/y");
    history.flush();
    expect(history.length).toBe(2);
    history.back();
    expect(history.location.pathname).toBe("/x");
  });

  it("flush is idempotent when nothing is queued", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"] });
    history.flush();
    history.flush();
    expect(history.length).toBe(1);
  });
});

describe("memory history: blockers", () => {
  it("[I-N9] a blocked push is held until proceed, then applied once", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const seen: Transition[] = [];
    history.block((transition) => {
      seen.push(transition);
    });
    expect(history.push("/b")).toBe(false);
    expect(history.location.pathname).toBe("/a");
    expect(history.pending?.location.pathname).toBe("/b");
    expect(seen).toHaveLength(1);
    seen[0]?.proceed();
    expect(history.location.pathname).toBe("/b");
    expect(history.pending).toBeUndefined();
    seen[0]?.proceed();
    expect(history.length).toBe(2);
  });

  it("[I-N9] cancel drops a held push", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    let held: Transition | undefined;
    history.block((transition) => {
      held = transition;
    });
    history.push("/b");
    held?.cancel();
    expect(history.pending).toBeUndefined();
    expect(history.location.pathname).toBe("/a");
  });

  it("[I-N9] a vetoed back reverts: the logical location stays, the target is held", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b", "/c"], ...syncFlush });
    const seen: Transition[] = [];
    history.block((transition) => {
      seen.push(transition);
    });
    history.back();
    expect(history.location.pathname).toBe("/c");
    expect(history.location.index).toBe(2);
    expect(seen[0]?.action).toBe("POP");
    expect(seen[0]?.delta).toBe(-1);
    expect(seen[0]?.location.pathname).toBe("/b");
  });

  it("[I-N9] several fast back events while a prompt is open do not desync the index", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b", "/c"], ...syncFlush });
    let calls = 0;
    history.block(() => {
      calls += 1;
    });
    history.back();
    history.back();
    history.back();
    expect(calls).toBe(3);
    expect(history.location.index).toBe(2);
    expect(history.location.pathname).toBe("/c");
  });

  it("[I-N11] proceed after a blocked POP re-issues from the right position", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b", "/c"], ...syncFlush });
    let calls = 0;
    let held: Transition | undefined;
    history.block((transition) => {
      calls += 1;
      held = transition;
    });
    history.back();
    held?.proceed();
    expect(calls).toBe(1);
    expect(history.location.pathname).toBe("/b");
    expect(history.location.index).toBe(1);
    expect(history.pending).toBeUndefined();
  });

  it("[I-N11] a navigation that starts while a POP is held supersedes it", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b", "/c"], ...syncFlush });
    let held: Transition | undefined;
    history.block((transition) => {
      if (transition.action === "POP") {
        held = transition;
      } else {
        transition.proceed();
      }
    });
    history.back();
    history.replace("/z");
    expect(history.pending).toBeUndefined();
    held?.proceed();
    expect(history.location.pathname).toBe("/z");
  });

  it("a blocker that proceeds synchronously lets the push through", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    history.block((transition) => {
      transition.proceed();
    });
    expect(history.push("/b")).toBe(true);
    expect(history.location.pathname).toBe("/b");
  });

  it("a later blocker can let through a change that an earlier one holds", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    history.block(() => undefined);
    history.block((transition) => {
      transition.proceed();
    });
    expect(history.push("/b")).toBe(true);
    expect(history.location.pathname).toBe("/b");
  });

  it("unblocking removes the blocker", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const unblock = history.block(() => undefined);
    expect(history.push("/b")).toBe(false);
    unblock();
    history.pending?.cancel();
    expect(history.push("/c")).toBe(true);
    expect(history.location.pathname).toBe("/c");
  });

  it("a stale transition's proceed does nothing", () => {
    const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
    const offered: Transition[] = [];
    history.block((transition) => {
      offered.push(transition);
    });
    history.push("/b");
    history.push("/c");
    offered[0]?.proceed();
    expect(history.location.pathname).toBe("/a");
    expect(history.pending).toBe(offered[1]);
    offered[1]?.proceed();
    expect(history.location.pathname).toBe("/c");
  });

  it("[I-N9] proceed on a blocked back applies that back", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b", "/c"], ...syncFlush });
    let held: Transition | undefined;
    history.block((transition) => {
      held = transition;
    });
    history.back();
    history.back();
    held?.proceed();
    expect(history.location.pathname).toBe("/b");
  });
});

describe("memory history: model-based property", () => {
  it("[I-N7] random push, replace, back, forward and go match a reference stack", () => {
    const hrefs = ["/a", "/b", "/c", "/a?x=1", "/b#h", "/d"];
    const operation = fc.oneof(
      fc.record({ op: fc.constant("push"), to: fc.constantFrom(...hrefs) }),
      fc.record({ op: fc.constant("replace"), to: fc.constantFrom(...hrefs) }),
      fc.record({ op: fc.constant("back"), to: fc.constant("") }),
      fc.record({ op: fc.constant("forward"), to: fc.constant("") }),
      fc.record({ op: fc.constant("go"), to: fc.constantFrom("-2", "2", "-1") }),
    );
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 60 }), (operations) => {
        const history = createMemoryHistory({ initialEntries: ["/a"], ...syncFlush });
        const model: string[] = ["/a"];
        let index = 0;
        for (const step of operations) {
          if (step.op === "push") {
            if (model[index] !== step.to) {
              model.splice(index + 1);
              model.push(step.to);
              index += 1;
            }
            history.push(step.to);
          } else if (step.op === "replace") {
            if (model[index] !== step.to) model[index] = step.to;
            history.replace(step.to);
          } else {
            const delta = step.op === "back" ? -1 : step.op === "forward" ? 1 : Number(step.to);
            const next = index + delta;
            if (next >= 0 && next < model.length) index = next;
            history.go(delta);
          }
          expect(pathnames(history)).toBe(model[index]);
          expect(history.location.index).toBe(index);
        }
        history.flush();
        expect(history.length).toBe(model.length);
      }),
      PROPS,
    );
  });
});

describe("browser history over the fake window", () => {
  it("stamps a foreign initial entry with index 0 without touching its URL", () => {
    const win = new FakeWindow("/start", null);
    const history = createBrowserHistory(win, syncFlush);
    expect(history.location.index).toBe(0);
    expect(history.location.pathname).toBe("/start");
    expect(win.urlAt(0)).toBe("/start");
    expect(win.currentState()).toEqual(expect.objectContaining({ __shadowIndex: 0 }));
    history.destroy();
  });

  it("[I-N7] resumes at an index already stored in the entry (survives a reload)", () => {
    const win = new FakeWindow("/x", { __shadowIndex: 5, __shadowState: { k: 1 } });
    const history = createBrowserHistory(win, syncFlush);
    expect(history.location.index).toBe(5);
    expect(history.location.state).toEqual({ k: 1 });
    history.destroy();
  });

  it("[I-N7] more than 60 entries: back and forward through the browser stack", () => {
    const win = new FakeWindow("/p0", null);
    const history = createBrowserHistory(win, syncFlush);
    for (let step = 1; step <= 70; step += 1) history.push(`/p${step}`);
    expect(history.location.index).toBe(70);
    expect(win.entryCount).toBe(71);
    const updates = collect(history);
    for (let step = 0; step < 60; step += 1) {
      history.back();
      win.runAllTraversals();
    }
    expect(history.location.pathname).toBe("/p10");
    expect(win.position).toBe(10);
    expect(updates.every((update) => update.action === "POP")).toBe(true);
    history.forward();
    win.runAllTraversals();
    expect(history.location.pathname).toBe("/p11");
    history.destroy();
  });

  it("a traversal reports POP with the entry's state", () => {
    const win = new FakeWindow("/a", null);
    const history = createBrowserHistory(win, syncFlush);
    history.push("/b", { step: "b" });
    const updates = collect(history);
    history.back();
    win.runAllTraversals();
    expect(updates).toEqual([
      expect.objectContaining({
        action: "POP",
        location: expect.objectContaining({ pathname: "/a" }),
      }),
    ]);
    history.destroy();
  });

  it("[I-N9] a vetoed back reverts, and fast double back while the prompt is open stays in sync", () => {
    const win = new FakeWindow("/a", null);
    const history = createBrowserHistory(win, syncFlush);
    history.push("/b");
    history.push("/c");
    let calls = 0;
    history.block(() => {
      calls += 1;
    });
    history.back();
    history.back();
    win.runAllTraversals();
    expect(history.location.index).toBe(2);
    expect(win.position).toBe(2);
    expect(history.location.pathname).toBe("/c");
    expect(calls).toBeGreaterThanOrEqual(1);
    history.destroy();
  });

  it("[I-N11] proceed after a vetoed browser back re-issues it from the logical position", () => {
    const win = new FakeWindow("/a", null);
    const history = createBrowserHistory(win, syncFlush);
    history.push("/b");
    history.push("/c");
    let held: Transition | undefined;
    history.block((transition) => {
      held = transition;
    });
    history.back();
    win.runAllTraversals();
    held?.proceed();
    win.runAllTraversals();
    expect(history.location.pathname).toBe("/b");
    expect(win.position).toBe(1);
    expect(history.location.index).toBe(1);
    history.destroy();
  });

  it("a foreign entry reached by traversal is adopted without asking blockers", () => {
    const win = new FakeWindow("/", null);
    win.writeEntry(false, null, "/foreign");
    const history = createBrowserHistory(win, syncFlush);
    history.block(() => {
      throw new Error("blockers must not run for a foreign entry");
    });
    expect(history.location.pathname).toBe("/foreign");
    history.back();
    win.runAllTraversals();
    expect(history.location.pathname).toBe("/");
    history.destroy();
  });

  it("[I-N8] writes are batched to one microtask: the URL changes only at the flush", async () => {
    const win = new FakeWindow("/a", null);
    const history = createBrowserHistory(win);
    history.push("/b");
    history.replace("/c");
    expect(win.entryCount).toBe(1);
    expect(history.location.pathname).toBe("/c");
    await Promise.resolve();
    expect(win.entryCount).toBe(2);
    expect(win.urlAt(1)).toBe("/c");
    history.destroy();
  });

  it("[I-N10] the unload guard prevents unload only while it says so, and can be removed", () => {
    const win = new FakeWindow("/a", null);
    const history = createBrowserHistory(win, syncFlush);
    let dirty = false;
    const release = history.guardUnload(() => dirty);
    expect(win.dispatchBeforeUnload()).toBe(false);
    dirty = true;
    expect(win.dispatchBeforeUnload()).toBe(true);
    history.push("/b");
    expect(history.location.pathname).toBe("/b");
    release();
    expect(win.listenerCount("beforeunload")).toBe(0);
    expect(win.dispatchBeforeUnload()).toBe(false);
    history.destroy();
  });

  it("[I-M2] destroy removes the popstate listener", () => {
    const win = new FakeWindow("/a", null);
    const history = createBrowserHistory(win, syncFlush);
    expect(win.listenerCount("popstate")).toBe(1);
    history.destroy();
    expect(win.listenerCount("popstate")).toBe(0);
  });

  it("[I-M2] destroy also removes unload guards that were never released", () => {
    const win = new FakeWindow("/a", null);
    const history = createBrowserHistory(win, syncFlush);
    history.guardUnload(() => true);
    expect(win.listenerCount("beforeunload")).toBe(1);
    history.destroy();
    expect(win.listenerCount("beforeunload")).toBe(0);
    expect(win.listenerCount("popstate")).toBe(0);
  });
});

describe("hash history over the fake window", () => {
  it("reads the path from the fragment", () => {
    const win = new FakeWindow("#/users/7?tab=x#top", null);
    const history = createHashHistory(win, syncFlush);
    expect(history.location.pathname).toBe("/users/7");
    expect(history.location.search).toBe("?tab=x");
    expect(history.location.hash).toBe("#top");
    history.destroy();
  });

  it("writes the path into the fragment and traverses back", () => {
    const win = new FakeWindow("#/a", null);
    const history = createHashHistory(win, syncFlush);
    history.push("/b");
    expect(win.urlAt(1)).toBe("#/b");
    history.back();
    win.runAllTraversals();
    expect(history.location.pathname).toBe("/a");
    history.destroy();
  });

  it("an empty fragment is the root path", () => {
    const win = new FakeWindow("#", null);
    const history = createHashHistory(win, syncFlush);
    expect(history.location.pathname).toBe("/");
    history.destroy();
  });

  it("[I-U12] a malformed fragment escape never throws", () => {
    const win = new FakeWindow("#/%zz", null);
    const history = createHashHistory(win, syncFlush);
    expect(history.location.pathname).toBe("/%zz");
    expect(decodeHash(win.location.hash)).toBe("/%zz");
    history.destroy();
  });
});
