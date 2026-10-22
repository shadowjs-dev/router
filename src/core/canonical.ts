/**
 * Canonical text for cache keys. Two values produce the same text exactly when they are equal as
 * data: object keys are sorted, arrays keep their order, and strings are JSON-quoted so that
 * separators inside values cannot collide.
 *
 * Only plain data is accepted. Map, Set, Date, class instances, BigInt, functions and symbols
 * would collide or change meaning when reduced to text, so they throw instead.
 */

type Work =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "exit"; readonly container: object };

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Serializes plain data to a canonical string. Iterative, so nesting depth cannot exhaust the
 * call stack.
 *
 * @param value Plain data: null, undefined, boolean, number, string, arrays and plain objects.
 * @returns Canonical text.
 * @throws TypeError for a non-plain value, a BigInt, a function, a symbol, or a cycle.
 * @example canonicalKey({ b: 1, a: [true] }) === canonicalKey({ a: [true], b: 1 }) // true
 * @since 1.0.0
 */
export function canonicalKey(value: unknown): string {
  const out: string[] = [];
  const stack: Work[] = [{ kind: "value", value }];
  const active = new Set<object>();
  while (stack.length > 0) {
    const work = stack.pop();
    if (work === undefined) break;
    if (work.kind === "text") {
      out.push(work.text);
      continue;
    }
    if (work.kind === "exit") {
      active.delete(work.container);
      continue;
    }
    const current = work.value;
    if (current === null) {
      out.push("z");
    } else if (current === undefined) {
      out.push("u");
    } else if (typeof current === "boolean") {
      out.push(current ? "T" : "F");
    } else if (typeof current === "number") {
      out.push(`n${Object.is(current, -0) ? "0" : String(current)};`);
    } else if (typeof current === "string") {
      out.push(`s${JSON.stringify(current)};`);
    } else if (typeof current === "object") {
      if (active.has(current)) {
        throw new TypeError("cannot build a cache key from a cyclic value");
      }
      if (Array.isArray(current)) {
        active.add(current);
        stack.push({ kind: "exit", container: current });
        stack.push({ kind: "text", text: "]" });
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (index < current.length - 1) stack.push({ kind: "text", text: "," });
          stack.push({ kind: "value", value: current[index] });
        }
        out.push("[");
      } else {
        if (!isPlainObject(current)) {
          throw new TypeError("cannot build a cache key from a non-plain object");
        }
        const record = current as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        active.add(current);
        stack.push({ kind: "exit", container: current });
        stack.push({ kind: "text", text: "}" });
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index];
          if (key === undefined) continue;
          stack.push({ kind: "value", value: record[key] });
          stack.push({ kind: "text", text: `${JSON.stringify(key)}:` });
          if (index > 0) stack.push({ kind: "text", text: "," });
        }
        out.push("{");
      }
    } else {
      throw new TypeError(`cannot build a cache key from a ${typeof current} value`);
    }
  }
  return out.join("");
}
