import { describe, expect, it } from "vitest";
import { createMemoryHistory } from "../../src/core/history";
import { createLoaderCache } from "../../src/core/loader-cache";
import { createNavigator, type NavigationRoute, redirect } from "../../src/core/navigation";
import { createFakeClock } from "../support/fake-clock";

function navigatorFor(routes: readonly NavigationRoute[]) {
  const clock = createFakeClock(0);
  const history = createMemoryHistory({ initialEntries: ["/"], scheduleFlush: (run) => run() });
  const navigator = createNavigator({
    routes,
    history,
    loaderCache: createLoaderCache({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      staleTime: 1_000_000,
    }),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    basePath: "",
    maxRedirects: 20,
    maxSearchLength: 4096,
    trailingSlash: "never",
    onError: () => undefined,
  });
  return { navigator, history };
}

describe("redirect with an object target", () => {
  it("[RDO-00] the target is built by a router or server: read with none, it says so", () => {
    // First test of the file: no navigator has been created yet.
    expect(() => redirect({ to: "/login" }).to).toThrow(/needs a router/);
    // Reading `replace` and creating the signal never needs the builder.
    expect(redirect({ to: "/login" }).replace).toBe(true);
  });

  it("[RDO-01] a pattern and its params become the path", () => {
    navigatorFor([]);
    expect(redirect({ to: "/posts/:id", params: { id: "7" } }).to).toBe("/posts/7");
  });

  it("[RDO-02] search is serialized with the canonical codec and appended", () => {
    navigatorFor([]);
    expect(redirect({ to: "/list", search: { tag: "a b", page: 2 } }).to).toBe(
      "/list?page=2&tag=a%20b",
    );
  });

  it("[RDO-03] params and search together, and a hash", () => {
    navigatorFor([]);
    expect(
      redirect({ to: "/posts/:id", params: { id: "a/b" }, search: { q: "x" }, hash: "top" }).to,
    ).toBe("/posts/a%2Fb?q=x#top");
  });

  it("[RDO-04] replace defaults to true and can be turned off, as for the string form", () => {
    expect(redirect({ to: "/login" }).replace).toBe(true);
    expect(redirect({ to: "/login", replace: false }).replace).toBe(false);
  });

  it("[RDO-05] the string form is unchanged and needs no router", () => {
    expect(redirect("/login").to).toBe("/login");
    expect(redirect("/login", { replace: false }).replace).toBe(false);
  });

  it("[RDO-06] a missing required param throws a RangeError when the target is read, like buildPath", () => {
    navigatorFor([]);
    // @ts-expect-error the pattern needs its id param
    const signal = redirect({ to: "/posts/:id" });
    expect(() => signal.to).toThrow(RangeError);
  });

  it("[RDO-07] an unknown param name does not compile", () => {
    navigatorFor([]);
    // @ts-expect-error "slug" is not a param of "/posts/:id"
    const signal = redirect({ to: "/posts/:id", params: { slug: "7" } });
    expect(() => signal.to).toThrow(RangeError);
  });

  it("[RDO-08] a navigator follows an object redirect from beforeLoad to the final location", async () => {
    const { navigator, history } = navigatorFor([
      {
        id: "old",
        path: "/old",
        beforeLoad: () => {
          throw redirect({ to: "/posts/:id", params: { id: "9" }, search: { tab: "edit" } });
        },
      },
      { id: "post", path: "/posts/:id" },
    ]);
    const outcome = await navigator.navigate("/old");
    expect(outcome.kind).toBe("success");
    expect(history.location.pathname).toBe("/posts/9");
    expect(history.location.search).toBe("?tab=edit");
  });
});
