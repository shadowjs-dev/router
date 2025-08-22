import type { Transition } from "../types";

export function applyEnterTransition(el: HTMLElement, t: Transition) {
  if (t === "none") return;
  if (t === "fade") {
    el.style.opacity = "0";
    el.style.transition = "opacity 120ms ease";
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
    return;
  }
  if (typeof t === "object" && t.enter) {
    try {
      void t.enter(el);
    } catch {}
  }
}

export function getHashPathSearch(): { pathname: string; search: string } {
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!raw) return { pathname: "/", search: "" };
  const qIndex = raw.indexOf("?");
  if (qIndex === -1) return { pathname: raw, search: "" };
  const p = raw.slice(0, qIndex) || "/";
  const s = raw.slice(qIndex);
  return { pathname: p, search: s };
}

export function getHistoryPathSearch(): { pathname: string; search: string } {
  return {
    pathname: window.location.pathname,
    search: window.location.search || "",
  };
}
