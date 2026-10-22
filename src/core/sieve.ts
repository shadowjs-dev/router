/**
 * A bounded cache with SIEVE eviction.
 *
 * Implemented from the algorithm in Zhang, Yang, Yue, Vigfusson and Rashmi, "SIEVE is Simpler
 * than LRU: an Efficient Turn-Key Eviction Algorithm for Web Caches" (NSDI 2024). Hits only set a
 * visited bit (no list reordering), and a hand moves from the oldest entry toward the newest,
 * evicting the first entry whose visited bit is clear. Scan-resistant, and cheap on reads.
 *
 * The same idea is used by TanStack Router's route matcher (MIT). The code here is written from
 * the paper, not copied.
 *
 * Pure: no timers, no globals, no module state. Each instance is bounded by its capacity.
 */

interface SieveNode<K, V> {
  readonly key: K;
  value: V;
  visited: boolean;
  /** Toward the newest entry. */
  newer: SieveNode<K, V> | undefined;
  /** Toward the oldest entry. */
  older: SieveNode<K, V> | undefined;
}

/**
 * Bounded map with SIEVE eviction.
 * @example
 * import { SieveCache } from "@shadow-js/router/core";
 * const cache = new SieveCache<string, number>(2);
 * cache.set("a", 1);
 * cache.set("b", 2);
 * cache.set("c", 3); // evicts one entry to stay within the capacity of 2
 * cache.size; // 2
 * @since 1.0.0
 */
export class SieveCache<K, V> {
  readonly #capacity: number;
  readonly #onEvict: ((key: K, value: V) => void) | undefined;
  readonly #nodes = new Map<K, SieveNode<K, V>>();
  #newest: SieveNode<K, V> | undefined;
  #oldest: SieveNode<K, V> | undefined;
  #hand: SieveNode<K, V> | undefined;

  /**
   * @param capacity Maximum number of entries; must be a positive integer.
   * @param onEvict Called with each entry removed by eviction (not by `delete` or `clear`).
   */
  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`SieveCache capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
    this.#onEvict = onEvict;
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.#nodes.size;
  }

  /** True when the key is present. Does not mark the entry as visited. */
  has(key: K): boolean {
    return this.#nodes.has(key);
  }

  /** Returns the value without marking the entry as visited. For inspection only. */
  peek(key: K): V | undefined {
    return this.#nodes.get(key)?.value;
  }

  /** Returns the value and marks the entry as visited. */
  get(key: K): V | undefined {
    const node = this.#nodes.get(key);
    if (node === undefined) return undefined;
    node.visited = true;
    return node.value;
  }

  /** Inserts or overwrites. Overwriting counts as a visit; inserting may evict one entry. */
  set(key: K, value: V): void {
    const existing = this.#nodes.get(key);
    if (existing !== undefined) {
      existing.value = value;
      existing.visited = true;
      return;
    }
    if (this.#nodes.size >= this.#capacity) this.#evictOne();
    const node: SieveNode<K, V> = {
      key,
      value,
      visited: false,
      newer: undefined,
      older: this.#newest,
    };
    if (this.#newest !== undefined) this.#newest.newer = node;
    this.#newest = node;
    if (this.#oldest === undefined) this.#oldest = node;
    this.#nodes.set(key, node);
  }

  /** Snapshot of the entries, oldest first. Does not mark anything as visited. */
  entries(): [K, V][] {
    const out: [K, V][] = [];
    for (let node = this.#oldest; node !== undefined; node = node.newer) {
      out.push([node.key, node.value]);
    }
    return out;
  }

  /** Removes the key. Returns false when it was absent. */
  delete(key: K): boolean {
    const node = this.#nodes.get(key);
    if (node === undefined) return false;
    this.#unlink(node);
    this.#nodes.delete(key);
    return true;
  }

  /** Removes every entry. Does not call `onEvict`. */
  clear(): void {
    this.#nodes.clear();
    this.#newest = undefined;
    this.#oldest = undefined;
    this.#hand = undefined;
  }

  #evictOne(): void {
    let candidate: SieveNode<K, V> | undefined = this.#hand ?? this.#oldest;
    while (candidate?.visited) {
      candidate.visited = false;
      candidate = candidate.newer ?? this.#oldest;
    }
    if (candidate === undefined) return;
    const next = candidate.newer;
    this.#unlink(candidate);
    this.#nodes.delete(candidate.key);
    this.#hand = next;
    if (this.#onEvict !== undefined) this.#onEvict(candidate.key, candidate.value);
  }

  #unlink(node: SieveNode<K, V>): void {
    if (node.newer !== undefined) {
      node.newer.older = node.older;
    } else {
      this.#newest = node.older;
    }
    if (node.older !== undefined) {
      node.older.newer = node.newer;
    } else {
      this.#oldest = node.newer;
    }
    if (this.#hand === node) this.#hand = node.newer;
    node.newer = undefined;
    node.older = undefined;
  }
}
