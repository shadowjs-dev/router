import { useStore, useEffect } from "@shadow-js/core";
import { getActiveRouter } from "../context";
import { isExternalUrl, normalizeHref } from "../utils";

type AProps<T = unknown> = {
  href: string | (() => string) | { (): string; __isStore?: boolean };
  replace?: boolean;
  state?: T;
  class?: string | (() => string) | string[];
  activeClass?: string;
  exact?: boolean;
  children?: unknown;
  target?: string;
  rel?: string;
  onClick?: (e: MouseEvent) => void;
};

function isStoreLike(v: unknown): boolean {
  return (
    typeof v === "function" &&
    v &&
    (v as { __isStore?: boolean }).__isStore === true
  );
}
function read<T>(v: T | (() => T)): T {
  if (typeof v === "function") return (v as () => T)();
  return v;
}

export function A<T = unknown>(props: AProps<T>) {
  const [winPath, setWinPath] = useStore<string>(window.location.pathname);
  useEffect(() => {
    const onPop = () => setWinPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  });

  const rawHref = () => {
    const raw = isStoreLike(props.href)
      ? (props.href as () => string)()
      : read(props.href);
    return String(raw ?? "");
  };

  const hrefValue = () => {
    const target = normalizeHref(rawHref());
    try {
      const r = getActiveRouter();
      if (r.mode === "hash") {
        const u = new URL(target, window.location.href);
        const p = u.pathname;
        const s = u.search || "";
        return "#" + (p + s);
      }
      return target;
    } catch {
      return target;
    }
  };

  const currentPath = () => {
    try {
      return getActiveRouter().path();
    } catch {
      return winPath();
    }
  };

  const isActive = () => {
    try {
      const cur = currentPath();
      const u = new URL(normalizeHref(rawHref()), window.location.href);
      const p = u.pathname;
      if (props.exact) return cur === p;
      return cur === p || cur.startsWith(p.endsWith("/") ? p : p + "/");
    } catch {
      return false;
    }
  };

  const classValue = () => {
    const base =
      typeof props.class === "function"
        ? props.class()
        : Array.isArray(props.class)
        ? props.class.join(" ")
        : props.class || "";
    const ac = props.activeClass && isActive() ? props.activeClass : "";
    return [base, ac].filter(Boolean).join(" ");
  };

  const handleClick = (e: MouseEvent) => {
    props.onClick?.(e);
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    if (props.target && props.target !== "_self") return;

    const target = normalizeHref(rawHref());
    if (isExternalUrl(target)) return;
    e.preventDefault();

    try {
      const r = getActiveRouter();
      r.navigate(target, { replace: props.replace, state: props.state });
    } catch {
      window.location.assign(hrefValue());
    }
  };

  return (
    <a
      href={hrefValue}
      target={props.target}
      rel={props.rel}
      class={classValue}
      onClick={handleClick}
      aria-current={() => (isActive() ? "page" : undefined)}
    >
      {props.children}
    </a>
  );
}
