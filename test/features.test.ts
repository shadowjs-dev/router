import { describe, expect, it } from "vitest";
import { createMatcher, createMemoryHistory } from "../src/core/index";
import { errorBoundaries } from "../src/features/errors";
import { compileMatchFilter, matchFilters } from "../src/features/filters";
import { loaderCache } from "../src/features/loaders";
import { notFoundUi } from "../src/features/not-found";
import { pendingUi } from "../src/features/pending";
import { relativeLinks } from "../src/features/relative";
import { scrollRestoration } from "../src/features/scroll";
import { searchValidation } from "../src/features/search";
import { createRouter, defineRoute } from "../src/index";

/** A router on a memory history, with the given routes and features. */
function routerWith(routes: Parameters<typeof createRouter>[0]["routes"], features = {}) {
  return createRouter({
    routes,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    ...features,
  });
}

describe("router features: a route's options need their feature, named at creation", () => {
  it("[FEAT-1] a route with head is refused without the head feature, and the message names it", () => {
    const page = defineRoute("/", { head: () => ({ tag: "title", children: "x" }) });
    expect(() => routerWith([page])).toThrow(
      /route "\/" uses head, which needs the "head" feature/,
    );
    expect(() => routerWith([page])).toThrow(/headManagement\(\) from @shadow-js\/router\/head/);
  });

  it("[FEAT-2] a route with error is refused without the errors feature", () => {
    const page = defineRoute("/", { error: () => null });
    expect(() => routerWith([page])).toThrow(/uses error, which needs the "errors" feature/);
    expect(() => routerWith([page], { features: [errorBoundaries()] })).not.toThrow();
  });

  it("[FEAT-3] a route with a loader is refused without the loaders feature", () => {
    const page = defineRoute("/", { loader: () => 1 });
    expect(() => routerWith([page])).toThrow(/uses loader, which needs the "loaders" feature/);
    expect(() => routerWith([page], { features: [loaderCache()] })).not.toThrow();
  });

  it("[FEAT-4] a route with matchFilters is refused without the filters feature", () => {
    const post = defineRoute("/posts/:id", { matchFilters: { id: /^\d+$/ } });
    expect(() => routerWith([post])).toThrow(
      /uses matchFilters, which needs the "filters" feature/,
    );
    expect(() => routerWith([post], { features: [matchFilters()] })).not.toThrow();
  });

  it("[FEAT-12] a route with validateSearch is refused without the search feature, and the message names the import", () => {
    const page = defineRoute("/", { validateSearch: (search) => search });
    expect(() => routerWith([page])).toThrow(
      /route "\/" uses validateSearch, which needs the "search" feature/,
    );
    expect(() => routerWith([page])).toThrow(
      /searchValidation\(\) from @shadow-js\/router\/search/,
    );
    expect(() => routerWith([page], { features: [searchValidation()] })).not.toThrow();
  });

  it("[FEAT-13] a route with notFound is refused without the not-found feature", () => {
    const page = defineRoute("/", { notFound: () => null });
    expect(() => routerWith([page])).toThrow(/uses notFound, which needs the "not-found" feature/);
    expect(() => routerWith([page])).toThrow(/notFoundUi\(\) from @shadow-js\/router\/not-found/);
    expect(() => routerWith([page], { features: [notFoundUi()] })).not.toThrow();
  });

  it("[FEAT-14] a route with pending is refused without the pending feature", () => {
    const page = defineRoute("/", { pending: () => null });
    expect(() => routerWith([page])).toThrow(/uses pending, which needs the "pending" feature/);
    expect(() => routerWith([page])).toThrow(/pendingUi\(\) from @shadow-js\/router\/pending/);
    expect(() => routerWith([page], { features: [pendingUi()] })).not.toThrow();
  });

  it("[FEAT-5] a feature given twice is a TypeError naming it", () => {
    expect(() =>
      routerWith([defineRoute("/", {})], { features: [scrollRestoration(), scrollRestoration()] }),
    ).toThrow(/"scroll" feature is given more than once/);
  });

  it("[FEAT-6] a router with no features navigates, hrefs and dehydrates without loaders", async () => {
    const home = defineRoute("/", { component: () => null });
    const about = defineRoute("/about", { component: () => null });
    const router = routerWith([home, about]);
    expect(router.href("/about")).toBe("/about");
    expect(await router.navigate("/about")).toEqual({
      kind: "success",
      location: { pathname: "/about", search: "", hash: "" },
    });
    expect(router.dehydrate()).toEqual({ version: 1, matches: [] });
    await router.preload("/about");
    router.dispose();
  });

  it("[FEAT-7] a relative target without the relativeLinks feature is refused with the feature named", () => {
    const router = routerWith([defineRoute("/", {}), defineRoute("/posts/:id", {})]);
    expect(() => router.href("edit", { relative: "path" })).toThrow(/needs the "relative" feature/);
    const linked = routerWith([defineRoute("/", {}), defineRoute("/posts/:id", {})], {
      features: [relativeLinks()],
    });
    expect(linked.href("edit", { relative: "path" })).toBe("/edit");
    router.dispose();
    linked.dispose();
  });

  it("[FEAT-8] createMatcher refuses matchFilters without a compiler, and names the feature", () => {
    const tree = [{ id: "post", path: "/posts/:id", matchFilters: { id: /^\d+$/ } }];
    expect(() => createMatcher(tree)).toThrow(
      /declares matchFilters, which need the matchFilters feature/,
    );
    expect(
      createMatcher(tree, { compileFilter: compileMatchFilter }).match("/posts/7"),
    ).toHaveLength(1);
  });

  it("[FEAT-9] a router's features are installed once per router (two routers do not share a loader cache)", async () => {
    const page = defineRoute("/", { loader: () => 1, component: () => null });
    const first = routerWith([page], { features: [loaderCache()] });
    const second = routerWith([page], { features: [loaderCache()] });
    await first.ready();
    await second.ready();
    expect(first.dehydrate().matches).toHaveLength(1);
    expect(second.dehydrate().matches).toHaveLength(1);
    first.dispose();
    second.dispose();
  });
});
