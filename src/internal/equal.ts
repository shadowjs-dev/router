/**
 * Equality for values read out of the router: identical values are equal, and plain data (search
 * values, params) compares by content. Anything else (class instances, functions, cycles, data past
 * the comparison budget) is not equal, which errs on the side of notifying readers.
 *
 * Iterative with a work budget, so neither the depth nor the size of a validator's output can
 * exhaust the call stack. Kept apart from the loader cache's key (`canonicalKey`) so a router that
 * uses no loaders does not link it.
 */

/** Pairs compared per call. Beyond this the values count as different (a cycle ends here too). */
const MAX_COMPARED_PAIRS = 10_000;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Equal as data: same keys with equal values, or same length with equal elements in order. */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const pending: [unknown, unknown][] = [[a, b]];
  for (let budget = MAX_COMPARED_PAIRS; pending.length > 0; budget -= 1) {
    if (budget === 0) return false;
    const pair = pending.pop();
    if (pair === undefined) break;
    const [x, y] = pair;
    if (Object.is(x, y) || x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
      for (let at = 0; at < x.length; at += 1) pending.push([x[at], y[at]]);
      continue;
    }
    if (Array.isArray(y) || !isPlainObject(x) || !isPlainObject(y)) return false;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    const left = x as Record<string, unknown>;
    const right = y as Record<string, unknown>;
    for (const key of keys) {
      if (!Object.hasOwn(right, key)) return false;
      pending.push([left[key], right[key]]);
    }
  }
  return true;
}
