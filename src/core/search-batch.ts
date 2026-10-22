import type { SearchPatch } from "./search";

/**
 * Batches search patches. Patches set in one tick (synchronous code, or one microtask) become one
 * navigation: their keys merge in call order, so a later value for a key wins, and a key set to
 * `undefined` stays in the patch so that the navigation removes it. The navigation replaces the
 * history entry only when every call in the batch asked for that.
 *
 * @since 1.0.0
 */
export interface SearchBatch {
  /** Queues a patch. `replace` true asks for the entry to be replaced rather than pushed. */
  set(patch: SearchPatch, replace: boolean): void;
}

/**
 * Creates a batch that calls `apply` once per tick with the merged patch.
 *
 * @param apply Receives the merged patch and whether to replace the entry.
 * @returns The batch.
 * @example
 * const batch = createSearchBatch((patch, replace) => navigate({ search: patch, replace }));
 * batch.set({ page: "2" }, false);
 * @since 1.0.0
 */
export function createSearchBatch(
  apply: (patch: SearchPatch, replace: boolean) => void,
): SearchBatch {
  let pending: SearchPatch = {};
  let replaceAll = true;
  let scheduled = false;
  return {
    set(patch: SearchPatch, replace: boolean): void {
      pending = { ...pending, ...patch };
      replaceAll = scheduled ? replaceAll && replace : replace;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        const merged = pending;
        const replaceNow = replaceAll;
        pending = {};
        replaceAll = true;
        scheduled = false;
        apply(merged, replaceNow);
      });
    },
  };
}
