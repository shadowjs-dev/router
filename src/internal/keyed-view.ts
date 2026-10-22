import { getOwner, runWithOwner, useMemo } from "@shadow-js/core";
import { sameData } from "./equal";

/**
 * A read-only record whose every key is its own memo. A reader of `view.tab` subscribes to the memo
 * of `tab` only, so a change of `page` (another memo) does not rerun it. Memos are created under the
 * owner that asked for the view, so they live as long as the component that uses them.
 *
 * Keys are created on first read. Beyond {@link MAX_TRACKED_KEYS} keys, reads go straight to the
 * source (correct, but they track the whole record), which keeps the number of memos bounded
 * whatever the URL contains.
 */

/** Most memos one view creates. Keys beyond this are read without memoization. */
export const MAX_TRACKED_KEYS = 64;

/**
 * Creates a per-key view over `source`. The source is read tracked, so reading a key of a missing
 * record gives `undefined` and makes the reader depend on the record's shape too (`in` and key
 * enumeration).
 *
 * @param source The record, or `undefined` when there is none yet.
 * @returns A read-only proxy over the record.
 */
export function keyedView<T extends object>(
  source: () => Readonly<Record<string, unknown>> | undefined,
): T {
  const owner = getOwner();
  const memos = new Map<string, () => unknown>();

  const read = (key: string): unknown => {
    const existing = memos.get(key);
    if (existing !== undefined) return existing();
    if (memos.size >= MAX_TRACKED_KEYS) return source()?.[key];
    const memo = runWithOwner(owner, () =>
      useMemo<unknown>(() => source()?.[key], { equals: sameData }),
    );
    memos.set(key, memo);
    return memo();
  };

  const target = Object.create(null) as Record<string, unknown>;
  return new Proxy(target, {
    get(_target, key): unknown {
      return typeof key === "string" ? read(key) : undefined;
    },
    has(_target, key): boolean {
      return typeof key === "string" && Object.hasOwn(source() ?? {}, key);
    },
    ownKeys(): (string | symbol)[] {
      return Reflect.ownKeys(source() ?? {});
    },
    getOwnPropertyDescriptor(_target, key): PropertyDescriptor | undefined {
      if (typeof key !== "string" || !Object.hasOwn(source() ?? {}, key)) return undefined;
      return { value: read(key), enumerable: true, configurable: true, writable: false };
    },
    set(): boolean {
      return false;
    },
    deleteProperty(): boolean {
      return false;
    },
    defineProperty(): boolean {
      return false;
    },
  }) as T;
}
