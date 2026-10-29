import { createRoot, useEffect } from "@shadow-js/core";

/** Runs `run` as a tracked effect in its own root. Returns the function that disposes it. */
export function createEffect(run: () => void): () => void {
  return createRoot((dispose) => {
    useEffect(run);
    return dispose;
  });
}
