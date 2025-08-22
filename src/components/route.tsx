import type { RouteConfig } from "../types";

// ---------- JSX DSL (<Route>) collection ----------

let __COLLECT_STACK: RouteConfig[][] = [];

function pushCollector(list: RouteConfig[]) {
  __COLLECT_STACK.push(list);
}
function currentCollector(): RouteConfig[] | null {
  return __COLLECT_STACK[__COLLECT_STACK.length - 1] || null;
}
function popCollector() {
  __COLLECT_STACK.pop();
}

export type RouteProps = Omit<RouteConfig, "children"> & {
  children?: unknown;
};

export function Route(props: RouteProps) {
  const bucket = currentCollector();
  if (bucket) {
    const node: RouteConfig = {
      path: props.path,
      component: props.component,
      layout: props.layout,
      children: [],
      redirect: props.redirect,
      transition: props.transition,
    };
    bucket.push(node);

    const runChild = (c: unknown) => {
      if (!c) return;
      if (Array.isArray(c)) return c.forEach(runChild);
      if (
        typeof c === "function" &&
        (c as { __isComponent?: boolean }).__isComponent
      ) {
        try {
          (c as () => void)();
        } catch {}
      }
    };

    pushCollector(node.children!);
    try {
      runChild(props.children);
    } finally {
      popCollector();
    }
  }

  return document.createDocumentFragment();
}

export function collectRoutesFromChildren(children: unknown): RouteConfig[] {
  const out: RouteConfig[] = [];
  const run = (c: unknown) => {
    if (!c) return;
    if (Array.isArray(c)) return c.forEach(run);
    if (
      typeof c === "function" &&
      (c as { __isComponent?: boolean }).__isComponent
    ) {
      try {
        (c as () => void)();
      } catch {}
    }
  };
  pushCollector(out);
  try {
    run(children);
  } finally {
    popCollector();
  }
  return out;
}
