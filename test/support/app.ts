import { flushSync } from "@shadow-js/core";
import { afterEach } from "vitest";

/** Lets pending promise continuations run, then flushes effects (the router is microtask-driven). */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < 80; tick += 1) await Promise.resolve();
  flushSync();
}

/** A fresh host element in the document body for one test. */
export function host(): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});
