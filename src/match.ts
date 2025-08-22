import type { RouteConfig } from "./types";
import { splitPath } from "./utils";

export type Segment =
  | { type: "static"; value: string }
  | { type: "param"; name: string; optional?: boolean }
  | { type: "wildcard" }
  | { type: "empty" };

export type CompiledRoute = {
  path: string;
  segs: Segment[];
  component?: RouteConfig["component"];
  layout?: RouteConfig["layout"];
  children: CompiledRoute[];
  redirect?: RouteConfig["redirect"];
  transition?: RouteConfig["transition"];
};

function compileSegments(path: string): Segment[] {
  const parts = splitPath(path);
  if (parts.length === 0) return [{ type: "empty" }];
  return parts.map((p) => {
    if (p === "*") return { type: "wildcard" } as Segment;
    if (p.startsWith(":")) {
      const raw = p.slice(1);
      const optional = raw.endsWith("?");
      const name = optional ? raw.slice(0, -1) : raw;
      return { type: "param", name, optional } as Segment;
    }
    return { type: "static", value: p } as Segment;
  });
}

export function compileRoutes(routes: RouteConfig[]): CompiledRoute[] {
  const out: CompiledRoute[] = [];

  function addNode(r: RouteConfig, into: CompiledRoute[]) {
    const node: CompiledRoute = {
      path: r.path,
      segs: compileSegments(r.path),
      component: r.component,
      layout: r.layout,
      children: [],
      redirect: r.redirect,
      transition: r.transition,
    };
    into.push(node);
    (r.children || []).forEach((c) => addNode(c, node.children));
  }

  routes.forEach((r) => addNode(r, out));
  return out;
}

export type Match = {
  chain: CompiledRoute[];
  params: Record<string, string>;
};

function matchNode(
  node: CompiledRoute,
  segs: string[],
  idx: number,
  accParams: Record<string, string>,
  chainAcc: CompiledRoute[]
): Match | null {
  let i = idx;

  for (const s of node.segs) {
    if (s.type === "empty") {
      // no-op
    } else if (s.type === "static") {
      if (segs[i] !== s.value) return null;
      i++;
    } else if (s.type === "param") {
      const val = segs[i];
      if (val == null) {
        if (s.optional) {
          // skip consuming
        } else {
          return null;
        }
      } else {
        accParams[s.name] = decodeURIComponent(val);
        i++;
      }
    } else if (s.type === "wildcard") {
      const rest = segs.slice(i).join("/");
      accParams.splat = decodeURIComponent(rest);
      i = segs.length;
      break;
    }
  }

  const nextChain = [...chainAcc, node];

  if (i === segs.length) {
    for (const child of node.children) {
      const m = matchNode(child, segs, i, { ...accParams }, nextChain);
      if (m) return m;
    }
    return { chain: nextChain, params: accParams };
  }

  for (const child of node.children) {
    const m = matchNode(child, segs, i, { ...accParams }, nextChain);
    if (m) return m;
  }

  return null;
}

export function matchRoutes(
  compiled: CompiledRoute[],
  path: string
): Match | null {
  const segs = splitPath(path);
  for (const top of compiled) {
    const m = matchNode(top, segs, 0, {}, []);
    if (m) return m;
  }
  return null;
}