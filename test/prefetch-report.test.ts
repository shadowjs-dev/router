import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "../src/core/history";
import { createPrefetchReport } from "../src/features/prefetch-report";

/** A report attached to a history and a clock the test moves. */
function attached(options: Parameters<typeof createPrefetchReport>[0] = {}) {
  const history = createMemoryHistory();
  let time = 0;
  const report = createPrefetchReport(options);
  const detach = report.attach({ history, clock: { now: () => time } }, 1000);
  return {
    report,
    history,
    detach,
    at(ms: number): void {
      time = ms;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPrefetchReport", () => {
  it("[ROUTER-PREFETCH-66] keeps the latest events up to maxEvents, while the summary still counts all of them", () => {
    const { report, at } = attached({ maxEvents: 3 });
    for (let index = 0; index < 5; index += 1) {
      at(index);
      report.event("skipped", `/p/${index}`, "viewport", "fresh");
    }
    expect(report.events.map((event) => event.href)).toEqual(["/p/2", "/p/3", "/p/4"]);
    expect(report.summary().viewport.skipped).toBe(5);
    expect(() => createPrefetchReport({ maxEvents: 0 })).toThrow(RangeError);
    expect(() => createPrefetchReport({ maxEvents: 1.5 })).toThrow(RangeError);
  });

  it("[ROUTER-PREFETCH-67] times a load from its start, and a target counts as used once, only while it is fresh", () => {
    const { report, history, at } = attached();
    at(10);
    report.event("started", "/a", "intent");
    at(40);
    report.event("loaded", "/a", "intent");
    expect(report.events.at(-1)).toMatchObject({ kind: "loaded", ms: 30 });
    at(500);
    history.push("/a");
    history.push("/b");
    history.push("/a");
    expect(report.events.filter((event) => event.kind === "used")).toHaveLength(1);
    expect(report.summary().intent).toMatchObject({ loaded: 1, used: 1, wasted: 0, hitRate: 1 });
    at(2000);
    report.event("started", "/c", "render");
    report.event("loaded", "/c", "render");
    at(3500);
    history.push("/c");
    expect(report.events.filter((event) => event.kind === "used")).toHaveLength(1);
    expect(report.summary().render).toMatchObject({ loaded: 1, used: 0, wasted: 1, hitRate: 0 });
  });

  it("[ROUTER-PREFETCH-68] clear forgets the events, the counts and the loaded targets; detach stops the history listener", () => {
    const { report, history, detach, at } = attached();
    at(1);
    report.event("loaded", "/a", "intent");
    report.clear();
    expect(report.events).toEqual([]);
    expect(report.summary().total.loaded).toBe(0);
    history.push("/a");
    expect(report.events).toEqual([]);
    report.event("loaded", "/b", "intent");
    detach();
    history.push("/b");
    expect(report.events.filter((event) => event.kind === "used")).toEqual([]);
  });

  it("[ROUTER-PREFETCH-69] a callback that throws is raised as its own error and does not stop the report", () => {
    const raised: unknown[] = [];
    vi.stubGlobal("queueMicrotask", (run: () => void) => {
      try {
        run();
      } catch (error) {
        raised.push(error);
      }
    });
    const boom = new Error("callback bug");
    const { report } = attached({
      onEvent: () => {
        throw boom;
      },
    });
    report.event("skipped", "/a", "render", "data-saver");
    report.event("skipped", "/b", "render", "data-saver");
    expect(raised).toEqual([boom, boom]);
    expect(report.summary().total.skipped).toBe(2);
  });
});
