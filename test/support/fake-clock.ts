/**
 * A deterministic clock with timers. `advance(ms)` moves time forward and runs every timer that
 * became due, in due-time order (ties in creation order). Nothing waits on real time.
 */
export interface FakeClock {
  now(): number;
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(handle: unknown): void;
  advance(ms: number): void;
  /** Timers that are scheduled and not yet fired or cleared. */
  readonly pendingTimers: number;
  /** Total timers ever created, for assertions about scheduling. */
  readonly timersCreated: number;
}

interface Timer {
  readonly id: number;
  readonly due: number;
  readonly run: () => void;
}

export function createFakeClock(start: number = 0): FakeClock {
  let time = start;
  let nextId = 1;
  let created = 0;
  let timers: Timer[] = [];
  return {
    now(): number {
      return time;
    },
    setTimeout(run: () => void, ms: number): number {
      const id = nextId;
      nextId += 1;
      created += 1;
      timers.push({ id, due: time + ms, run });
      return id;
    },
    clearTimeout(handle: unknown): void {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    advance(ms: number): void {
      const target = time + ms;
      for (;;) {
        let next: Timer | undefined;
        for (const timer of timers) {
          if (timer.due <= target && (next === undefined || timer.due < next.due)) next = timer;
        }
        if (next === undefined) break;
        time = next.due;
        timers = timers.filter((timer) => timer.id !== next?.id);
        next.run();
      }
      time = target;
    },
    get pendingTimers(): number {
      return timers.length;
    },
    get timersCreated(): number {
      return created;
    },
  };
}
