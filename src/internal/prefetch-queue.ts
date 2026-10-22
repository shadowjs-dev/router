/**
 * A first-in, first-out queue that runs at most `concurrency` tasks at once. A key that is already queued or running
 * shares that task: asking again adds a claim instead of a second task, and the task is dropped (aborted if it runs)
 * only when every claim has been released. Used by the `prefetch` feature to keep speculative loads from crowding out
 * the page's own requests.
 * @internal
 */

/** The claim one caller holds on a queued task. @internal */
export interface PrefetchTicket {
  /** Releases the claim. When it was the last one, the task is removed (queued) or aborted (running). Idempotent. */
  cancel(): void;
  /** Settles when the task is over: finished, removed or aborted, or the queue was disposed. Never rejects. */
  readonly done: Promise<void>;
}

/** A queue of keyed tasks. @internal */
export interface PrefetchQueue {
  /**
   * Adds a task for `key`, or joins the live one. The task receives a signal that aborts when its last claim is
   * released or the queue is disposed; its rejection is ignored (the task reports its own failures).
   */
  enqueue(key: string, task: (signal: AbortSignal) => Promise<unknown>): PrefetchTicket;
  /** Tasks running now. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly pending: number;
  /** Aborts what runs, drops what waits, and refuses later tasks. */
  dispose(): void;
}

interface Entry {
  readonly key: string;
  readonly task: (signal: AbortSignal) => Promise<unknown>;
  claims: number;
  controller: AbortController | undefined;
  finished: boolean;
  readonly done: Promise<void>;
  readonly end: () => void;
}

const INERT_TICKET: PrefetchTicket = Object.freeze({
  cancel(): void {
    // Nothing was queued.
  },
  done: Promise.resolve(),
});

/**
 * Creates a queue.
 * @param options `concurrency`: the most tasks that run at once (at least 1).
 * @returns The queue.
 * @internal
 */
export function createPrefetchQueue(options: { readonly concurrency: number }): PrefetchQueue {
  const limit = Math.max(1, Math.floor(options.concurrency));
  const live = new Map<string, Entry>();
  const waiting: Entry[] = [];
  let active = 0;
  let disposed = false;

  const finish = (entry: Entry): void => {
    if (entry.finished) return;
    entry.finished = true;
    live.delete(entry.key);
    if (entry.controller !== undefined) active -= 1;
    entry.end();
  };

  const pump = (): void => {
    while (!disposed && active < limit) {
      const entry = waiting.shift();
      if (entry === undefined) return;
      const controller = new AbortController();
      entry.controller = controller;
      active += 1;
      const settle = (): void => {
        finish(entry);
        pump();
      };
      let running: Promise<unknown>;
      try {
        running = entry.task(controller.signal);
      } catch {
        running = Promise.resolve();
      }
      running.then(settle, settle);
    }
  };

  return {
    enqueue(key, task): PrefetchTicket {
      if (disposed) return INERT_TICKET;
      let entry = live.get(key);
      if (entry === undefined) {
        let end: () => void = () => undefined;
        const done = new Promise<void>((resolve) => {
          end = resolve;
        });
        entry = { key, task, claims: 0, controller: undefined, finished: false, done, end };
        live.set(key, entry);
        waiting.push(entry);
      }
      const claimed = entry;
      claimed.claims += 1;
      let held = true;
      pump();
      return {
        done: claimed.done,
        cancel(): void {
          if (!held) return;
          held = false;
          claimed.claims -= 1;
          if (claimed.claims > 0 || claimed.finished) return;
          const queuedAt = waiting.indexOf(claimed);
          if (queuedAt !== -1) waiting.splice(queuedAt, 1);
          claimed.controller?.abort();
          finish(claimed);
          pump();
        },
      };
    },
    get active(): number {
      return active;
    },
    get pending(): number {
      return waiting.length;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of live.values()) {
        entry.controller?.abort();
        entry.finished = true;
        entry.end();
      }
      live.clear();
      waiting.length = 0;
      active = 0;
    },
  };
}
