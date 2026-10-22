import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPrefetchQueue, type PrefetchQueue } from "../src/internal/prefetch-queue";

/** A task the test controls: it starts when the queue schedules it and ends when `finish` runs. */
interface RunningTask {
  readonly key: string;
  finish(): void;
}

interface Harness {
  readonly queue: PrefetchQueue;
  /** Keys in the order the queue actually started them. */
  readonly started: string[];
  /** Keys in the order they were accepted as a new entry (not a dedupe hit on a live key). */
  readonly created: string[];
  /** Tasks that have started and not yet finished. */
  readonly running: RunningTask[];
  /** Peak number of tasks running at the same time. */
  peak(): number;
  /** Requests a key; returns the ticket so tests can cancel it. */
  request(key: string): ReturnType<PrefetchQueue["enqueue"]>;
}

function harness(concurrency: number): Harness {
  const queue = createPrefetchQueue({ concurrency });
  const started: string[] = [];
  const created: string[] = [];
  const running: RunningTask[] = [];
  let peak = 0;
  const live = new Set<string>();

  return {
    queue,
    started,
    created,
    running,
    peak: () => peak,
    request(key) {
      const ticket = queue.enqueue(key, () => {
        started.push(key);
        return new Promise<void>((resolve) => {
          const task: RunningTask = {
            key,
            finish: () => {
              const index = running.indexOf(task);
              if (index !== -1) running.splice(index, 1);
              live.delete(key);
              resolve();
            },
          };
          running.push(task);
          peak = Math.max(peak, running.length);
        });
      });
      if (!live.has(key)) {
        live.add(key);
        created.push(key);
      }
      return ticket;
    },
  };
}

/** A task that never ends on its own. */
function never(): Promise<void> {
  return new Promise<void>(() => undefined);
}

/** Lets the queue react to settled tasks; a macrotask waits out every pending microtask. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const keys = fc.constantFrom("a", "b", "c", "d", "e");
const operation = fc.oneof(
  fc.record({ kind: fc.constant("request" as const), key: keys }),
  fc.record({ kind: fc.constant("finish" as const), index: fc.integer({ min: 0, max: 9 }) }),
);

describe("prefetch queue", () => {
  it("[ROUTER-PREFETCH-01] never runs more tasks than the concurrency cap", async () => {
    const h = harness(3);
    for (const key of ["a", "b", "c", "d", "e"]) h.request(key);
    await flush();
    expect(h.started).toEqual(["a", "b", "c"]);
    h.running[0]?.finish();
    await flush();
    expect(h.started).toEqual(["a", "b", "c", "d"]);
    expect(h.peak()).toBe(3);
  });

  it("[ROUTER-PREFETCH-02] sends queued keys out in the order they were requested", async () => {
    const h = harness(1);
    for (const key of ["x", "y", "z"]) h.request(key);
    await flush();
    h.running[0]?.finish();
    await flush();
    h.running[0]?.finish();
    await flush();
    h.running[0]?.finish();
    await flush();
    expect(h.started).toEqual(["x", "y", "z"]);
  });

  it("[ROUTER-PREFETCH-03] a key requested twice shares one task and runs once", async () => {
    const h = harness(2);
    const first = h.request("a");
    const second = h.request("a");
    await flush();
    expect(h.started).toEqual(["a"]);
    expect(h.queue.active).toBe(1);
    first.cancel();
    await flush();
    expect(h.queue.active).toBe(1);
    second.cancel();
    await flush();
    expect(h.queue.active).toBe(0);
  });

  it("[ROUTER-PREFETCH-04] canceling a queued key before it starts means it never runs", async () => {
    const h = harness(1);
    h.request("a");
    const queued = h.request("b");
    h.request("c");
    await flush();
    queued.cancel();
    h.running[0]?.finish();
    await flush();
    h.running[0]?.finish();
    await flush();
    expect(h.started).toEqual(["a", "c"]);
  });

  it("[ROUTER-PREFETCH-05] canceling a running key aborts its signal and frees the slot at once", async () => {
    const seen: AbortSignal[] = [];
    const queue = createPrefetchQueue({ concurrency: 1 });
    const started: string[] = [];
    const running = queue.enqueue("a", (signal) => {
      seen.push(signal);
      started.push("a");
      return never();
    });
    queue.enqueue("b", () => {
      started.push("b");
      return never();
    });
    await flush();
    expect(started).toEqual(["a"]);
    running.cancel();
    await flush();
    expect(seen[0]?.aborted).toBe(true);
    expect(started).toEqual(["a", "b"]);
    queue.dispose();
  });

  it("[ROUTER-PREFETCH-06] dispose aborts running tasks and drops queued ones", async () => {
    const seen: AbortSignal[] = [];
    const queue = createPrefetchQueue({ concurrency: 1 });
    const started: string[] = [];
    queue.enqueue("a", (signal) => {
      seen.push(signal);
      started.push("a");
      return never();
    });
    queue.enqueue("b", () => {
      started.push("b");
      return never();
    });
    await flush();
    queue.dispose();
    await flush();
    expect(seen[0]?.aborted).toBe(true);
    expect(started).toEqual(["a"]);
    expect(queue.active).toBe(0);
    expect(queue.pending).toBe(0);
  });

  it("[ROUTER-PREFETCH-07] property: the cap holds, starts are FIFO, and no key is live twice", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operation, { maxLength: 60 }),
        fc.integer({ min: 1, max: 4 }),
        async (ops, concurrency) => {
          const h = harness(concurrency);
          const live = new Set<string>();

          for (const op of ops) {
            if (op.kind === "request") {
              live.add(op.key);
              h.request(op.key);
            } else if (h.running.length > 0) {
              const task = h.running[op.index % h.running.length];
              task?.finish();
              if (task !== undefined) live.delete(task.key);
            }
            await flush();

            // The cap holds at every moment.
            expect(h.running.length).toBeLessThanOrEqual(concurrency);
            expect(h.queue.active).toBe(h.running.length);
            // No key runs twice at once.
            expect(new Set(h.running.map((task) => task.key)).size).toBe(h.running.length);
            // Every live key is either running or queued, and nothing else is tracked.
            expect(h.queue.active + h.queue.pending).toBe(live.size);
            // Starts follow the order keys were first accepted.
            expect(h.started).toEqual(h.created.slice(0, h.started.length));
          }
          expect(h.peak()).toBeLessThanOrEqual(concurrency);
          h.queue.dispose();
        },
      ),
      { numRuns: 200 },
    );
  });
});
