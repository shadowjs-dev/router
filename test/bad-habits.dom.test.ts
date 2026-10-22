import { describe, expect, it, vi } from "vitest";
import { defineRoute } from "../src/index";
import { type Rig, rig, settle } from "./support/rig";
import type { RouterTestWindow } from "./support/router-window";

/**
 * Bad habits in router scroll restoration: each test feeds the router storage a developer might
 * leave behind, or moves through history in a way a developer often does, then asserts the
 * documented outcome. Storage problems warn in development through `console.warn`; malformed rows
 * are dropped without a diagnostic, which the tests pin as the documented behavior.
 */

const ROUTES = (): ReturnType<typeof defineRoute>[] => [
  defineRoute("/a", {}),
  defineRoute("/b", {}),
  defineRoute("/c", {}),
  defineRoute("/d", {}),
];

const KEY = "shadow:router:scroll";

/** Storage rows the router wrote, as `[index, x, y]` triples. */
function rows(win: RouterTestWindow): Array<[number, number, number]> {
  const raw = win.sessionStorage.items.get(KEY);
  return raw === undefined ? [] : (JSON.parse(raw) as Array<[number, number, number]>);
}

/** Returns the console.warn messages so far and clears the spy, as R-TEST-7 requires. */
function takeWarnings(): string[] {
  const spy = vi.mocked(console.warn);
  const messages = spy.mock.calls.map((args) => String(args[0]));
  spy.mockClear();
  return messages;
}

/** Browser-history rig at `/a` whose storage is seeded with `raw` before the router starts. */
function seeded(raw: string): Rig {
  return rig(ROUTES(), {
    url: "/a",
    prepare: (win) => {
      win.sessionStorage.items.set(KEY, raw);
    },
  });
}

describe("bad habits: router scroll storage", () => {
  it("[BAD-ROUTER-01] malformed JSON in the scroll key warns once in development and the router still navigates", async () => {
    const r = seeded("{not json");
    await r.router.ready();
    const warnings = takeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ROUTER_SCROLL_STORAGE");
    await r.router.navigate("/b");
    expect(r.router.state.location()?.pathname).toBe("/b");
    expect(r.errors).toEqual([]);
    takeWarnings();
    r.router.dispose();
  });

  it("[BAD-ROUTER-02] a JSON object instead of the expected array is ignored with no warning", async () => {
    const r = seeded('{"0":[0,1,2]}');
    await r.router.ready();
    expect(takeWarnings()).toEqual([]);
    // The stored object is never restored: the first save overwrites it with the live position.
    r.win.scrollY = 0;
    await r.router.navigate("/b");
    expect(rows(r.win)).toEqual([[0, 0, 0]]);
    expect(takeWarnings()).toEqual([]);
    r.router.dispose();
  });

  it("[BAD-ROUTER-03] malformed rows in the array are dropped silently and never restored", async () => {
    const r = seeded(
      JSON.stringify([
        ["x", 1, 1],
        [0, "a", 2],
        [1, 4],
      ]),
    );
    await r.router.ready();
    r.win.scrollY = 0;
    await r.router.navigate("/b");
    // The garbage rows are gone from storage after the save; only the live position remains.
    expect(rows(r.win)).toEqual([[0, 0, 0]]);
    expect(takeWarnings()).toEqual([]);
    r.router.dispose();
  });

  it("[BAD-ROUTER-04] pushing from a back position discards the saved positions of the forward entries", async () => {
    const r = rig(ROUTES(), { url: "/a" });
    await r.router.ready();
    r.win.scrollY = 10;
    await r.router.navigate("/b");
    r.win.scrollY = 20;
    await r.router.navigate("/c");
    r.router.history.go(-1);
    r.win.runAllTraversals();
    await settle();
    expect(r.router.state.location()?.pathname).toBe("/b");
    await r.router.navigate("/d");
    // The forward entry (index 2, the old /c) is gone, so its saved position is dropped.
    expect(rows(r.win).map(([index]) => index)).toEqual([0, 1]);
    expect(r.errors).toEqual([]);
    r.router.dispose();
  });

  it("[BAD-ROUTER-05] pushing past 500 entries evicts the oldest saved position, so the first entry is never restored", async () => {
    const r = rig(ROUTES(), { url: "/a" });
    await r.router.ready();
    for (let step = 0; step < 501; step += 1) {
      r.win.scrollY = step;
      await r.router.navigate(step % 2 === 0 ? "/b" : "/c");
    }
    const saved = rows(r.win);
    expect(saved).toHaveLength(500);
    expect(saved.map(([index]) => index)).not.toContain(0);
    expect(Math.min(...saved.map(([index]) => index))).toBe(1);
    expect(takeWarnings()).toEqual([]);
    r.router.dispose();
  });
});
