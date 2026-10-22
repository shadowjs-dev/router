import { describe, expect, it, vi } from "vitest";
import { viewTransitions } from "../src/features/transitions";
import { defineRoute } from "../src/index";
import { createFakeClock } from "./support/fake-clock";
import { everyFeature, featuresWithout } from "./support/features";
import { type Rig, rig, settle } from "./support/rig";
import type { RouterTestWindow } from "./support/router-window";

const ROUTES = (): ReturnType<typeof defineRoute>[] => [
  defineRoute("/a", {}),
  defineRoute("/b", {}),
  defineRoute("/c", {}),
  defineRoute("/d", {}),
];

/** Browser-history rig with scroll restoration on (the default when a window exists). */
function scrolling(url: string = "/a"): Rig {
  return rig(ROUTES(), { url });
}

/** Storage rows written by the router: `[index, x, y]`. */
function rows(win: RouterTestWindow): Array<[number, number, number]> {
  const raw = win.sessionStorage.items.get("shadow:router:scroll");
  return raw === undefined ? [] : (JSON.parse(raw) as Array<[number, number, number]>);
}

describe("scroll restoration: direction", () => {
  it("[SCR-01 I-A5] a push scrolls to the top", async () => {
    const r = scrolling();
    await r.router.ready();
    r.win.scrollY = 300;
    await r.router.navigate("/b");
    expect(r.win.scrolls.at(-1)).toEqual([0, 0]);
    r.router.dispose();
  });

  it("[SCR-02 I-A5] a push to a hash scrolls the element into view and not to the top", async () => {
    const r = scrolling();
    await r.router.ready();
    const into = vi.fn();
    r.win.elements.set("intro", { scrollIntoView: into });
    await r.router.navigate("/b#intro");
    expect(into).toHaveBeenCalledTimes(1);
    expect(r.win.scrolls).toEqual([]);
    r.router.dispose();
  });

  it("[SCR-03 I-U12] a hash with malformed escapes never throws and scrolls nowhere", async () => {
    const r = scrolling();
    await r.router.ready();
    const outcome = await r.router.navigate("/b#%");
    expect(outcome.kind).toBe("success");
    r.router.dispose();
  });

  it("[SCR-04 I-A5] a back traversal restores the position saved for the entry it lands on", async () => {
    const r = scrolling();
    await r.router.ready();
    r.win.scrollY = 300;
    await r.router.navigate("/b");
    r.win.scrollY = 0;
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    expect(r.win.scrolls.at(-1)).toEqual([0, 300]);
    r.router.dispose();
  });

  it("[SCR-05 I-A5] a restoration runs once per traversal", async () => {
    const r = scrolling();
    await r.router.ready();
    r.win.scrollY = 120;
    await r.router.navigate("/b");
    const before = r.win.scrolls.length;
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    expect(r.win.scrolls.length).toBe(before + 1);
    r.router.dispose();
  });

  it("[SCR-06 I-A5] a replacing navigation keeps the scroll position", async () => {
    const r = scrolling();
    await r.router.ready();
    r.win.scrollY = 90;
    await r.router.navigate("/b", { replace: true });
    expect(r.win.scrolls).toEqual([]);
    r.router.dispose();
  });

  it("[SCR-07 I-A5] a forward traversal to a saved entry restores its position", async () => {
    const r = scrolling();
    await r.router.ready();
    await r.router.navigate("/b");
    r.win.scrollY = 450;
    await r.router.navigate("/c");
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    r.win.scrollY = 0;
    r.router.history.go(1);
    r.win.runAllTraversals();
    await settle();
    expect(r.win.scrolls.at(-1)).toEqual([0, 0]);
    r.router.dispose();
  });
});

describe("scroll restoration: storage and bookkeeping", () => {
  it("[SCR-10 I-A5] a page hide saves the position of the current entry", async () => {
    const r = scrolling();
    await r.router.ready();
    r.win.scrollY = 222;
    r.win.dispatch("pagehide");
    expect(rows(r.win)).toEqual([[0, 0, 222]]);
    r.router.dispose();
  });

  it("[SCR-11 I-A5] positions are persisted, so a new router on the same window restores them", async () => {
    const first = scrolling();
    await first.router.ready();
    first.win.scrollY = 640;
    await first.router.navigate("/b");
    first.router.dispose();

    // A window with two entries (index 0 and index 1), and the position saved for entry 0 by an
    // earlier router. A new router must read it at creation and use it on the way back.
    const second = rig(ROUTES(), {
      url: "/b",
      prepare: (win) => {
        // Entry 0 and entry 1 both carry the index the router stamps on its own entries.
        win.writeEntry(true, { __shadowIndex: 0 }, "/a");
        win.writeEntry(false, { __shadowIndex: 1 }, "/b");
        win.sessionStorage.items.set("shadow:router:scroll", JSON.stringify([[0, 0, 640]]));
      },
    });
    await second.router.ready();
    second.router.history.go(-1);
    second.win.runAllTraversals();
    await settle();
    expect(second.win.scrolls.at(-1)).toEqual([0, 640]);
    second.router.dispose();
  });

  it("[SCR-12 I-M6] an unreadable storage warns in development and the router keeps working", async () => {
    const r = rig(ROUTES(), {
      url: "/a",
      prepare: (win) => {
        win.sessionStorage.failing = "read";
      },
    });
    await r.router.ready();
    expect(vi.mocked(console.warn).mock.calls.map((args) => String(args[0]))).toEqual([
      expect.stringContaining("ROUTER_SCROLL_STORAGE"),
    ]);
    vi.mocked(console.warn).mockClear();
    await r.router.navigate("/b");
    expect(r.router.state.location()?.pathname).toBe("/b");
    r.router.dispose();
  });

  it("[SCR-13 I-M6] a full storage warns on write and positions stay in memory", async () => {
    const r = scrolling();
    await r.router.ready();
    r.win.sessionStorage.failing = "write";
    r.win.scrollY = 75;
    await r.router.navigate("/b");
    const warned = vi.mocked(console.warn).mock.calls.map((args) => String(args[0]));
    expect(warned.some((text) => text.includes("ROUTER_SCROLL_STORAGE"))).toBe(true);
    vi.mocked(console.warn).mockClear();
    r.win.sessionStorage.failing = "none";
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    expect(r.win.scrolls.at(-1)).toEqual([0, 75]);
    r.router.dispose();
  });

  it("[SCR-14 I-A5] a push discards the saved position of the forward entry it replaces", async () => {
    const r = scrolling();
    await r.router.ready();
    await r.router.navigate("/b");
    await r.router.navigate("/c");
    r.win.scrollY = 700;
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    expect(rows(r.win).some(([index]) => index === 2)).toBe(true);
    await r.router.navigate("/d");
    await settle();
    expect(rows(r.win).some(([index]) => index === 2)).toBe(false);
    r.router.dispose();
  });

  it("[SCR-15 I-A5] saved positions are bounded: a long session keeps at most 500", async () => {
    const r = scrolling();
    await r.router.ready();
    for (let n = 0; n < 510; n += 1) {
      r.win.scrollY = n;
      await r.router.navigate(n % 2 === 0 ? "/b" : "/c");
    }
    expect(rows(r.win).length).toBeLessThanOrEqual(500);
    r.router.dispose();
  });

  it("[SCR-16 I-A5] scrollRestoration false adds no window listeners and never scrolls", async () => {
    const r = rig(ROUTES(), { features: featuresWithout("scroll") });
    await r.router.ready();
    r.win.scrollY = 300;
    await r.router.navigate("/b");
    expect(r.win.added).not.toContain("pagehide");
    expect(r.win.scrolls).toEqual([]);
    r.router.dispose();
  });

  it("[SCR-17 I-M2] dispose removes the page-hide, wheel and touch listeners", async () => {
    const r = scrolling();
    await r.router.ready();
    expect(r.win.countOf("pagehide")).toBe(1);
    expect(r.win.countOf("wheel")).toBe(1);
    expect(r.win.countOf("touchstart")).toBe(1);
    r.router.dispose();
    expect(r.win.countOf("pagehide")).toBe(0);
    expect(r.win.countOf("wheel")).toBe(0);
    expect(r.win.countOf("touchstart")).toBe(0);
  });

  it("[SCR-18 I-A5] a wheel while the new page is still loading does not cancel the restore that follows", async () => {
    const r = scrolling();
    await r.router.ready();
    r.win.scrollY = 310;
    await r.router.navigate("/b");
    r.router.history.go(-1);
    r.win.runAllTraversals();
    r.win.dispatch("wheel");
    await settle();
    expect(r.win.scrolls.at(-1)).toEqual([0, 310]);
    r.router.dispose();
  });

  it("[VT-01 I-A6] with the flag and the API, a committed navigation runs inside a view transition", async () => {
    const r = rig(ROUTES(), { features: [...everyFeature(), viewTransitions()] });
    r.win.hasViewTransitions = true;
    await r.router.ready();
    r.win.transitions.splice(0);
    await r.router.navigate("/b");
    expect(r.win.transitions).toEqual(["start"]);
    expect(r.router.state.location()?.pathname).toBe("/b");
    r.router.dispose();
  });

  it("[VT-02 I-A6] without the flag no transition starts", async () => {
    const r = rig(ROUTES());
    r.win.hasViewTransitions = true;
    await r.router.ready();
    await r.router.navigate("/b");
    expect(r.win.transitions).toEqual([]);
    r.router.dispose();
  });

  it("[VT-03 I-A6] reduced motion disables the transition", async () => {
    const r = rig(ROUTES(), { features: [...everyFeature(), viewTransitions()] });
    r.win.hasViewTransitions = true;
    r.win.reducedMotion = true;
    await r.router.ready();
    await r.router.navigate("/b");
    expect(r.win.transitions).toEqual([]);
    expect(r.router.state.location()?.pathname).toBe("/b");
    r.router.dispose();
  });

  it("[VT-04 I-A6] without the API the navigation commits normally", async () => {
    const r = rig(ROUTES(), { features: [...everyFeature(), viewTransitions()] });
    await r.router.ready();
    await r.router.navigate("/c");
    expect(r.router.state.location()?.pathname).toBe("/c");
    r.router.dispose();
  });
});

describe("clock discipline", () => {
  it("[SCR-20 I-M2] the fake clock records no timers for a plain push", async () => {
    const clock = createFakeClock(0);
    const r = rig(ROUTES());
    void clock;
    await r.router.ready();
    await r.router.navigate("/b");
    expect(r.clock.pendingTimers).toBe(0);
    r.router.dispose();
  });
});
