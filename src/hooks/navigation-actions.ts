import { getActiveRouter } from "../context";
import type { NavigateOptions } from "../types";

export function navigate(to: string, opts?: NavigateOptions) {
  const r = getActiveRouter();
  r.navigate(to, opts);
}

export const redirect = navigate;
