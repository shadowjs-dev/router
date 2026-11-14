import { createRoot, flushSync, useEffect, useSignal } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { notFoundUi } from "../src/features/not-found";
import { createMemoryHistory, createRouter, defineRoute } from "../src/index";
import { settle } from "./support/rig";

/*
 * `routePath`: the address bar keeps the visible path, the routes are matched against the path the option returns.
 * Two hosts share `/` and `/about`; each is a folder of the route tree, and the mapping picks the folder.
 */

function tree(root: { readonly notFound?: () => null } = {}) {
  return [
    defineRoute("", {
      id: "root",
      ...root,
      children: [
        defineRoute("/", { id: "site-home" }),
        defineRoute("/about", { id: "site-about" }),
        defineRoute("/_hosts/dash", {
          id: "dash",
          children: [
            defineRoute("/", { id: "dash-home" }),
            defineRoute("/about", { id: "dash-about" }),
          ],
        }),
      ],
    }),
  ];
}

const intoDash = (path: string): string => (path === "/" ? "/_hosts/dash" : `/_hosts/dash${path}`);

function ids(router: ReturnType<typeof createRouter>): string[] {
  return router.state.matches().map((match) => match.id);
}

describe("createRouter({ routePath })", () => {
  it("[RP-10] the first load matches the mapped path and the location stays the visible one", async () => {
    const router = createRouter({
      routes: tree(),
      history: createMemoryHistory({ initialEntries: ["/about?x=1"] }),
      routePath: intoDash,
    });
    await router.ready();
    expect(ids(router)).toEqual(["root", "dash", "dash-about"]);
    expect(router.state.location()?.pathname).toBe("/about");
    expect(router.state.location()?.search).toBe("?x=1");
    router.dispose();
  });

  it("[RP-11] the same tree without the option reaches the other host's routes", async () => {
    const router = createRouter({
      routes: tree(),
      history: createMemoryHistory({ initialEntries: ["/about"] }),
    });
    await router.ready();
    expect(ids(router)).toEqual(["root", "site-about"]);
    router.dispose();
  });

  it("[RP-12] navigation and the back button stay on the host: the history holds visible paths, the matches are the host's", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({ routes: tree(), history, routePath: intoDash });
    await router.ready();
    expect(ids(router)).toEqual(["root", "dash", "dash-home"]);
    await router.navigate("/about");
    expect(ids(router)).toEqual(["root", "dash", "dash-about"]);
    expect(history.location.pathname).toBe("/about");
    history.back();
    await settle();
    expect(history.location.pathname).toBe("/");
    expect(ids(router)).toEqual(["root", "dash", "dash-home"]);
    history.forward();
    await settle();
    expect(history.location.pathname).toBe("/about");
    expect(ids(router)).toEqual(["root", "dash", "dash-about"]);
    router.dispose();
  });

  it("[RP-13] a link built for a visible path is that path, and a path the host has no route for is not found", async () => {
    const router = createRouter({
      routes: tree(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routePath: intoDash,
    });
    await router.ready();
    expect(router.href("/about" as never)).toBe("/about");
    const outcome = await router.navigate("/nope");
    expect(outcome.kind).toBe("notFound");
    // The route-tree path is not reachable by writing it: it is mapped again.
    const direct = await router.navigate("/_hosts/dash/about");
    expect(direct.kind).toBe("notFound");
    router.dispose();
  });

  it("[RP-14] a base is stripped before the mapping and kept in the location", async () => {
    const seen: string[] = [];
    const router = createRouter({
      routes: tree(),
      history: createMemoryHistory({ initialEntries: ["/app/about"] }),
      base: "/app",
      routePath: (path) => {
        seen.push(path);
        return intoDash(path);
      },
    });
    await router.ready();
    expect(ids(router)).toEqual(["root", "dash", "dash-about"]);
    expect(router.state.location()?.pathname).toBe("/app/about");
    expect(seen.every((path) => path === "/about")).toBe(true);
    router.dispose();
  });

  it("[RP-15] the mapping runs untracked: a signal it reads does not subscribe the memo that matches for the not-found chain", async () => {
    const [host, setHost] = useSignal("dash");
    let mapped = 0;
    const routes = tree({ notFound: () => null });
    const router = createRouter({
      routes,
      features: [notFoundUi()],
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routePath: (path) => {
        mapped += 1;
        return host() === "dash" ? intoDash(path) : path;
      },
    });
    await router.ready();
    await router.navigate("/nope");
    let runs = 0;
    const dispose = createRoot((stop) => {
      useEffect(() => {
        runs += 1;
        router.state.matches();
      });
      return stop;
    });
    flushSync();
    expect(runs).toBe(1);
    const before = mapped;
    expect(before).toBeGreaterThan(0);
    setHost("site");
    flushSync();
    expect(mapped).toBe(before);
    dispose();
    router.dispose();
  });
});
