import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, type History } from "../../src/core/history";
import { createLoaderCache, type LoaderCache } from "../../src/core/loader-cache";
import {
  createNavigator,
  isNotFound,
  isRedirect,
  type NavigationOutcome,
  type NavigationRoute,
  type NavigationSnapshot,
  type Navigator,
  notFound,
  redirect,
} from "../../src/core/navigation";
import { createFakeClock, type FakeClock } from "../support/fake-clock";

const PROPS = { seed: 5, numRuns: 300 } as const;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 40; tick += 1) await Promise.resolve();
}

interface Rig {
  readonly navigator: Navigator;
  readonly history: History;
  readonly cache: LoaderCache;
  readonly clock: FakeClock;
  readonly errors: unknown[];
  readonly snapshots: NavigationSnapshot[];
}

function rig(
  routes: readonly NavigationRoute[],
  options: {
    readonly initial?: string;
    readonly basePath?: string;
    readonly maxRedirects?: number;
    readonly maxSearchLength?: number;
    readonly trailingSlash?: "never" | "always" | "preserve";
    readonly staleTime?: number;
  } = {},
): Rig {
  const clock = createFakeClock(0);
  const history = createMemoryHistory({
    initialEntries: [options.initial ?? "/"],
    scheduleFlush: (run) => run(),
  });
  const cache = createLoaderCache({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    staleTime: options.staleTime ?? 1_000_000,
  });
  const errors: unknown[] = [];
  const snapshots: NavigationSnapshot[] = [];
  const navigator = createNavigator({
    routes,
    history,
    loaderCache: cache,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    basePath: options.basePath ?? "",
    maxRedirects: options.maxRedirects ?? 20,
    maxSearchLength: options.maxSearchLength ?? 4096,
    trailingSlash: options.trailingSlash ?? "never",
    onError: (error) => {
      errors.push(error);
    },
  });
  navigator.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });
  return { navigator, history, cache, clock, errors, snapshots };
}

function kindOf(outcome: NavigationOutcome): string {
  return outcome.kind;
}

const home: NavigationRoute = { id: "home", path: "/" };
const about: NavigationRoute = { id: "about", path: "/about" };

describe("navigation: basic commits", () => {
  it("[I-N12] navigating to the current location does not add an entry", async () => {
    const { navigator, history } = rig([home, about], { initial: "/about" });
    const outcome = await navigator.navigate("/about");
    expect(kindOf(outcome)).toBe("success");
    history.flush();
    expect(history.length).toBe(1);
  });

  it("commits the location and the matched chain", async () => {
    const { navigator, history } = rig([home, about]);
    const outcome = await navigator.navigate("/about");
    expect(kindOf(outcome)).toBe("success");
    expect(history.location.pathname).toBe("/about");
    expect(navigator.getSnapshot().matches.map((match) => match.id)).toEqual(["about"]);
    expect(navigator.getSnapshot().status).toBe("idle");
  });

  it("[I-N13] a query-only target keeps the current pathname", async () => {
    const { navigator, history } = rig([{ id: "users", path: "/users/:id" }], {
      initial: "/users/5",
    });
    await navigator.navigate("?tab=2");
    expect(history.location.pathname).toBe("/users/5");
    expect(history.location.search).toBe("?tab=2");
  });

  it("replace writes the current entry instead of pushing", async () => {
    const { navigator, history } = rig([home, about]);
    await navigator.navigate("/about", { replace: true });
    history.flush();
    expect(history.length).toBe(1);
    expect(history.location.pathname).toBe("/about");
  });

  it("navigate passes the state to history", async () => {
    const { navigator, history } = rig([home, about]);
    await navigator.navigate("/about", { state: { from: "home" } });
    expect(history.location.state).toEqual({ from: "home" });
  });

  it("[I-U2] a protocol-relative target stays on this origin", async () => {
    const { navigator, history } = rig([{ id: "any", path: "/*" }]);
    const outcome = await navigator.navigate("//evil.example/x");
    expect(kindOf(outcome)).toBe("success");
    expect(history.location.pathname).toBe("/evil.example/x");
  });

  it("[I-U10] an unsafe target is an error outcome and changes nothing", async () => {
    const { navigator, history } = rig([home]);
    const outcome = await navigator.navigate("javascript:alert(1)");
    expect(kindOf(outcome)).toBe("error");
    expect(history.location.pathname).toBe("/");
  });

  it("absolute URLs are not routed: an error outcome", async () => {
    const { navigator, history } = rig([home]);
    const outcome = await navigator.navigate("https://evil.example/x");
    expect(kindOf(outcome)).toBe("error");
    expect(history.location.pathname).toBe("/");
  });

  it("[I-U1] a target with an empty interior segment is a notFound with no route", async () => {
    const { navigator } = rig([home, about]);
    const outcome = await navigator.navigate("/a//b");
    expect(outcome).toEqual({ kind: "notFound", routeId: undefined });
  });

  it("a path that matches no route commits with no matches and a NotFound error", async () => {
    const { navigator, history } = rig([home, about]);
    const outcome = await navigator.navigate("/nope");
    expect(kindOf(outcome)).toBe("notFound");
    expect(history.location.pathname).toBe("/nope");
    expect(navigator.getSnapshot().matches).toEqual([]);
    expect(isNotFound(navigator.getSnapshot().error)).toBe(true);
  });

  it("[I-U13] the trailing-slash policy sets the committed pathname", async () => {
    const { navigator, history } = rig([about], { trailingSlash: "never" });
    await navigator.navigate("/about/");
    expect(history.location.pathname).toBe("/about");
  });

  it("[I-U9] a base path is applied once: matches below it, commits with it", async () => {
    const { navigator, history } = rig([{ id: "users", path: "/users/:id" }], {
      basePath: "/app",
      initial: "/app",
    });
    const outcome = await navigator.navigate("/users/7");
    expect(kindOf(outcome)).toBe("success");
    expect(history.location.pathname).toBe("/app/users/7");
    expect(navigator.getSnapshot().matches[0]?.params).toEqual({ id: "7" });
  });

  it("[I-U9] '/app' does not claim '/application' when navigating", async () => {
    const { navigator } = rig([{ id: "users", path: "/users/:id" }], {
      basePath: "/app",
      initial: "/app",
    });
    const outcome = await navigator.navigate("/application/users/1");
    expect(kindOf(outcome)).toBe("notFound");
  });

  it("[I-N2] the default maxRedirects is 20 and a chain under the limit succeeds", async () => {
    const routes: NavigationRoute[] = [];
    for (let step = 0; step < 5; step += 1) {
      routes.push({
        id: `r${step}`,
        path: `/r${step}`,
        beforeLoad: () => {
          throw redirect(`/r${step + 1}`);
        },
      });
    }
    routes.push({ id: "end", path: "/r5" });
    const { navigator, history } = rig(routes);
    expect(kindOf(await navigator.navigate("/r0"))).toBe("success");
    expect(history.location.pathname).toBe("/r5");
  });
});

describe("navigation: redirects and control flow", () => {
  it("[I-N2] a redirect loop stops at maxRedirects with a clear error", async () => {
    const routes: NavigationRoute[] = [
      {
        id: "a",
        path: "/a",
        beforeLoad: () => {
          throw redirect("/b");
        },
      },
      {
        id: "b",
        path: "/b",
        beforeLoad: () => {
          throw redirect("/a");
        },
      },
    ];
    const { navigator, history } = rig(routes, { maxRedirects: 3 });
    const outcome = await navigator.navigate("/a");
    expect(kindOf(outcome)).toBe("error");
    expect((outcome as { error: Error }).error.message).toMatch(/redirect/i);
    expect((outcome as { error: Error }).error.message).toMatch(/3/);
    expect(history.location.pathname).toBe("/");
  });

  it("[I-N3] a redirect thrown from beforeLoad and one thrown from a loader behave the same", async () => {
    const fromBefore: NavigationRoute[] = [
      {
        id: "old",
        path: "/old",
        beforeLoad: () => {
          throw redirect("/new");
        },
      },
      { id: "new", path: "/new" },
    ];
    const fromLoader: NavigationRoute[] = [
      { id: "old", path: "/old", loader: () => Promise.reject(redirect("/new")) },
      { id: "new", path: "/new" },
    ];
    const first = rig(fromBefore);
    const second = rig(fromLoader);
    expect(kindOf(await first.navigator.navigate("/old"))).toBe("success");
    expect(kindOf(await second.navigator.navigate("/old"))).toBe("success");
    expect(first.history.location.pathname).toBe("/new");
    expect(second.history.location.pathname).toBe("/new");
    first.history.flush();
    second.history.flush();
    expect(first.history.length).toBe(second.history.length);
  });

  it("[I-N3] a redirect adds no entry: the navigation writes one entry for the final target", async () => {
    const { navigator, history } = rig(
      [
        {
          id: "old",
          path: "/old",
          beforeLoad: () => {
            throw redirect("/new");
          },
        },
        { id: "new", path: "/new" },
      ],
      { initial: "/start" },
    );
    await navigator.navigate("/old");
    history.flush();
    expect(history.length).toBe(2);
    expect(history.location.pathname).toBe("/new");
    history.back();
    expect(history.location.pathname).toBe("/start");
  });

  it("[I-N3] a redirect from a replacing navigation replaces the current entry", async () => {
    const { navigator, history } = rig(
      [
        {
          id: "old",
          path: "/old",
          beforeLoad: () => {
            throw redirect("/new");
          },
        },
        { id: "new", path: "/new" },
      ],
      { initial: "/start" },
    );
    await navigator.navigate("/old", { replace: true });
    history.flush();
    expect(history.length).toBe(1);
    expect(history.location.pathname).toBe("/new");
  });

  it("a redirect to an absolute external URL is an error", async () => {
    const { navigator, history } = rig([
      {
        id: "out",
        path: "/out",
        beforeLoad: () => {
          throw redirect("https://evil.example/");
        },
      },
    ]);
    const outcome = await navigator.navigate("/out");
    expect(kindOf(outcome)).toBe("error");
    expect(history.location.pathname).toBe("/");
  });

  it("[I-L8] notFound thrown from a loader yields a notFound outcome for that route", async () => {
    const { navigator } = rig([
      { id: "post", path: "/posts/:id", loader: () => Promise.reject(notFound()) },
    ]);
    const outcome = await navigator.navigate("/posts/9");
    expect(outcome).toEqual({ kind: "notFound", routeId: "post" });
    expect(isNotFound(navigator.getSnapshot().error)).toBe(true);
  });

  it("[I-L8] a notFound from a child loader keeps the loaded layout above it with its loader data", async () => {
    const { navigator } = rig([
      {
        id: "layout",
        path: "",
        loader: () => ({ viewer: "ada" }),
        children: [
          {
            id: "project",
            path: "/w/:workspace/p/:project",
            loader: () => Promise.reject(notFound()),
          },
        ],
      },
    ]);
    const outcome = await navigator.navigate("/w/atlas/p/nope");
    expect(outcome).toEqual({ kind: "notFound", routeId: "project" });
    const snapshot = navigator.getSnapshot();
    expect(isNotFound(snapshot.error)).toBe(true);
    expect(snapshot.matches.map((match) => [match.id, match.loaderData])).toEqual([
      ["layout", { viewer: "ada" }],
    ]);
  });

  it("[I-L8] a notFound from beforeLoad still loads the layouts above it, so they keep their data", async () => {
    const loaded: string[] = [];
    const { navigator } = rig([
      {
        id: "layout",
        path: "",
        loader: () => {
          loaded.push("layout");
          return { viewer: "ada" };
        },
        children: [
          {
            id: "project",
            path: "/w/:workspace/p/:project",
            beforeLoad: () => {
              throw notFound({ routeId: "project" });
            },
            loader: () => {
              loaded.push("project");
              return "never";
            },
          },
        ],
      },
    ]);
    expect(await navigator.navigate("/w/atlas/p/nope")).toEqual({
      kind: "notFound",
      routeId: "project",
    });
    expect(loaded).toEqual(["layout"]);
    expect(navigator.getSnapshot().matches.map((match) => match.loaderData)).toEqual([
      { viewer: "ada" },
    ]);
  });

  it("[I-L8] notFound thrown from beforeLoad yields a notFound outcome for that route", async () => {
    const { navigator } = rig([
      {
        id: "gate",
        path: "/gate",
        beforeLoad: () => {
          throw notFound({ routeId: "gate" });
        },
      },
    ]);
    expect(await navigator.navigate("/gate")).toEqual({ kind: "notFound", routeId: "gate" });
  });

  it("[I-L9] control-flow signals are not reported as errors", async () => {
    const { navigator, errors } = rig([
      {
        id: "old",
        path: "/old",
        beforeLoad: () => {
          throw redirect("/new");
        },
      },
      { id: "gone", path: "/gone", loader: () => Promise.reject(notFound()) },
      { id: "new", path: "/new" },
    ]);
    await navigator.navigate("/old");
    await navigator.navigate("/gone");
    expect(errors).toEqual([]);
  });

  it("redirect and notFound are recognized by their guards", () => {
    expect(isRedirect(redirect("/x"))).toBe(true);
    expect(isRedirect(notFound())).toBe(false);
    expect(isNotFound(notFound())).toBe(true);
    expect(isNotFound(new Error("x"))).toBe(false);
    expect(isRedirect(undefined)).toBe(false);
  });

  it("an ordinary error from a loader is an error outcome and the snapshot error", async () => {
    const boom = new Error("db down");
    const { navigator, history } = rig([
      { id: "post", path: "/posts/:id", loader: () => Promise.reject(boom) },
    ]);
    const outcome = await navigator.navigate("/posts/1");
    expect(outcome).toEqual({ kind: "error", error: boom });
    expect(navigator.getSnapshot().error).toBe(boom);
    expect(navigator.getSnapshot().status).toBe("idle");
    expect(history.location.pathname).toBe("/");
  });
});

describe("navigation: beforeLoad and loaders", () => {
  it("[I-L1] beforeLoad runs serially, parent first, and loaders run in parallel", async () => {
    const log: string[] = [];
    const gates = [deferred<string>(), deferred<string>()];
    const { navigator } = rig([
      {
        id: "parent",
        path: "/p",
        beforeLoad: () => {
          log.push("parent:before");
        },
        loader: () => {
          log.push("parent:loader");
          return gates[0]?.promise ?? "";
        },
        children: [
          {
            id: "child",
            path: "c",
            beforeLoad: () => {
              log.push("child:before");
            },
            loader: () => {
              log.push("child:loader");
              return gates[1]?.promise ?? "";
            },
          },
        ],
      },
    ]);
    const pending = navigator.navigate("/p/c");
    await settle();
    expect(log).toEqual(["parent:before", "child:before", "parent:loader", "child:loader"]);
    gates[0]?.resolve("a");
    gates[1]?.resolve("b");
    expect(kindOf(await pending)).toBe("success");
  });

  it("[I-L1] a failing parent beforeLoad stops child beforeLoad and child loaders", async () => {
    let childBefore = 0;
    let childLoader = 0;
    const { navigator } = rig([
      {
        id: "parent",
        path: "/p",
        beforeLoad: () => {
          throw new Error("unauthorized");
        },
        children: [
          {
            id: "child",
            path: "c",
            beforeLoad: () => {
              childBefore += 1;
            },
            loader: () => {
              childLoader += 1;
              return 1;
            },
          },
        ],
      },
    ]);
    const outcome = await navigator.navigate("/p/c");
    expect(kindOf(outcome)).toBe("error");
    expect(childBefore).toBe(0);
    expect(childLoader).toBe(0);
  });

  it("beforeLoad results merge into the context seen by children and loaders", async () => {
    const seen: unknown[] = [];
    const { navigator } = rig([
      {
        id: "auth",
        path: "/app",
        beforeLoad: () => ({ user: "ada" }),
        children: [
          {
            id: "page",
            path: "page",
            beforeLoad: ({ context }) => ({ greeting: `hi ${String(context["user"])}` }),
            loader: ({ context }) => {
              seen.push(context);
              return 1;
            },
          },
        ],
      },
    ]);
    await navigator.navigate("/app/page");
    expect(seen).toEqual([{ user: "ada", greeting: "hi ada" }]);
    expect(navigator.getSnapshot().matches.map((match) => match.context)).toEqual([
      { user: "ada" },
      { user: "ada", greeting: "hi ada" },
    ]);
  });

  it("the loader gets the params, the validated search, the location and the intent", async () => {
    const calls: unknown[] = [];
    const { navigator } = rig([
      {
        id: "post",
        path: "/posts/:id",
        loader: (args) => {
          calls.push({ params: args.params, intent: args.intent, path: args.location.pathname });
          return 1;
        },
      },
    ]);
    await navigator.navigate("/posts/3");
    expect(calls).toEqual([{ params: { id: "3" }, intent: "navigate", path: "/posts/3" }]);
  });

  it("[I-L2] a superseded navigation aborts the signal its loader received", async () => {
    const gate = deferred<string>();
    let seen: AbortSignal | undefined;
    const { navigator } = rig([
      {
        id: "slow",
        path: "/slow",
        loader: (args) => {
          seen = args.signal;
          return gate.promise;
        },
      },
      { id: "fast", path: "/fast" },
    ]);
    const first = navigator.navigate("/slow");
    await settle();
    expect(seen?.aborted).toBe(false);
    await navigator.navigate("/fast");
    expect(seen?.aborted).toBe(true);
    expect(kindOf(await first)).toBe("canceled");
  });

  it("[I-L10] a hydrated route is not fetched again on the first client render", async () => {
    let calls = 0;
    const { navigator, cache } = rig(
      [
        {
          id: "post",
          path: "/posts/:id",
          loader: () => {
            calls += 1;
            return "client";
          },
        },
      ],
      { initial: "/posts/1" },
    );
    cache.seed({ routeId: "post", params: { id: "1" }, value: "server", updatedAt: 0 });
    const outcome = await navigator.hydrate();
    expect(kindOf(outcome)).toBe("success");
    expect(calls).toBe(0);
    expect(navigator.getSnapshot().matches[0]?.loaderData).toBe("server");
  });

  it("reload runs the loaders again even when the data is fresh", async () => {
    let calls = 0;
    const { navigator } = rig([
      {
        id: "post",
        path: "/posts/:id",
        loader: () => {
          calls += 1;
          return calls;
        },
      },
    ]);
    await navigator.navigate("/posts/1");
    await navigator.reload();
    expect(calls).toBe(2);
  });

  it("[I-N2] the loaderDeps function keys the cache by search, so each page loads once", async () => {
    let calls = 0;
    const { navigator } = rig([
      {
        id: "list",
        path: "/list",
        loaderDeps: (search) => search["page"],
        loader: ({ deps }) => {
          calls += 1;
          return deps;
        },
      },
    ]);
    await navigator.navigate("/list?page=1");
    await navigator.navigate("/list?page=2");
    await navigator.navigate("/list?page=1");
    expect(calls).toBe(2);
  });

  it("[I-S4] a validateSearch runs once per location, and its result reaches the hooks", async () => {
    let validations = 0;
    const seen: unknown[] = [];
    const { navigator } = rig([
      {
        id: "list",
        path: "/list",
        validateSearch: (search) => {
          validations += 1;
          return { page: Number(search["page"] ?? 1) };
        },
        loader: ({ search }) => {
          seen.push(search);
          return 0;
        },
      },
    ]);
    await navigator.navigate("/list?page=4");
    expect(validations).toBe(1);
    expect(seen).toEqual([{ page: 4 }]);
  });

  it("[I-S4] a failing validateSearch is a route error by default", async () => {
    const { navigator } = rig([
      {
        id: "list",
        path: "/list",
        validateSearch: () => {
          throw new Error("page must be a number");
        },
      },
    ]);
    const outcome = await navigator.navigate("/list?page=x");
    expect(kindOf(outcome)).toBe("error");
    expect((outcome as { error: Error }).error.message).toBe("page must be a number");
  });

  it("[I-S4] onSearchError supplies an overridable fallback", async () => {
    const { navigator } = rig([
      {
        id: "list",
        path: "/list",
        validateSearch: () => {
          throw new Error("bad");
        },
        onSearchError: () => ({ page: 1 }),
        loader: ({ search }) => search,
      },
    ]);
    const outcome = await navigator.navigate("/list?page=x");
    expect(kindOf(outcome)).toBe("success");
    expect(navigator.getSnapshot().matches[0]?.loaderData).toEqual({ page: 1 });
  });

  it("a query over the search cap is an error outcome, not a crash", async () => {
    const { navigator } = rig([{ id: "any", path: "/any" }], { maxSearchLength: 10 });
    const outcome = await navigator.navigate(`/any?x=${"y".repeat(50)}`);
    expect(kindOf(outcome)).toBe("error");
    expect((outcome as { error: Error }).error).toBeInstanceOf(RangeError);
  });

  it("[I-L3] loader data that depends on a non-plain deps value is an error, not a shared key", async () => {
    const { navigator } = rig([
      { id: "x", path: "/x", loaderDeps: () => new Map(), loader: () => 1 },
    ]);
    const outcome = await navigator.navigate("/x");
    expect(kindOf(outcome)).toBe("error");
  });

  it("the snapshot matches carry params per depth and loader data", async () => {
    const { navigator } = rig([
      {
        id: "shop",
        path: "/shop/:cat",
        loader: () => "shop-data",
        children: [
          { id: "item", path: ":sku", loader: ({ params }) => `item ${params["sku"] ?? ""}` },
        ],
      },
    ]);
    await navigator.navigate("/shop/books/b1");
    const matches = navigator.getSnapshot().matches;
    expect(matches.map((match) => match.params)).toEqual([
      { cat: "books" },
      { cat: "books", sku: "b1" },
    ]);
    expect(matches.map((match) => match.loaderData)).toEqual(["shop-data", "item b1"]);
  });
});

describe("navigation: last navigation wins", () => {
  it("[I-N1] a superseded navigation is canceled and its late result is discarded", async () => {
    const gate = deferred<string>();
    const { navigator, history } = rig([
      { id: "slow", path: "/slow", loader: () => gate.promise },
      { id: "fast", path: "/fast" },
    ]);
    const first = navigator.navigate("/slow");
    const second = navigator.navigate("/fast");
    expect(kindOf(await second)).toBe("success");
    gate.resolve("late");
    expect(kindOf(await first)).toBe("canceled");
    expect(history.location.pathname).toBe("/fast");
    expect(navigator.getSnapshot().location?.pathname).toBe("/fast");
  });

  it("[I-N1] a superseded navigation never writes history", async () => {
    const gate = deferred<string>();
    const { navigator, history } = rig([
      { id: "slow", path: "/slow", loader: () => gate.promise },
      { id: "other", path: "/other" },
    ]);
    const first = navigator.navigate("/slow");
    await navigator.navigate("/other");
    gate.resolve("late");
    await first;
    history.flush();
    expect(history.length).toBe(2);
  });

  it("[I-N1] random interleavings always settle on the last target that started", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            target: fc.constantFrom("/a", "/b", "/c"),
            delay: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (plan) => {
          const clock = createFakeClock(0);
          const history = createMemoryHistory({ scheduleFlush: (run) => run() });
          const cache = createLoaderCache({
            now: clock.now,
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout,
            staleTime: 1_000_000,
          });
          const navigator = createNavigator({
            routes: [
              { id: "a", path: "/a", loader: () => Promise.resolve("a") },
              { id: "b", path: "/b", loader: () => Promise.resolve("b") },
              { id: "c", path: "/c", loader: () => Promise.resolve("c") },
            ],
            history,
            loaderCache: cache,
            now: clock.now,
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout,
          });
          // Timers fire in due order and, for equal due times, in creation order. The last
          // navigation to start is the last one in that order.
          const order = plan
            .map((step, index) => ({ ...step, index }))
            .sort((left, right) => left.delay - right.delay || left.index - right.index);
          const finished = order.map(
            (step) =>
              new Promise<NavigationOutcome>((resolve) => {
                clock.setTimeout(() => {
                  navigator.navigate(step.target).then(resolve);
                }, step.delay);
              }),
          );
          clock.advance(10);
          await Promise.all(finished);
          await settle();
          const last = order[order.length - 1];
          expect(navigator.getSnapshot().status).toBe("idle");
          expect(navigator.getSnapshot().location?.pathname).toBe(last?.target);
        },
      ),
      PROPS,
    );
  });
});

describe("navigation: preload", () => {
  it("[I-N4] preload never commits the location or writes history", async () => {
    const { navigator, history } = rig([about]);
    await navigator.preload("/about");
    history.flush();
    expect(history.location.pathname).toBe("/");
    expect(history.length).toBe(1);
    expect(navigator.getSnapshot().matches).toEqual([]);
  });

  it("[I-N4] preload does not run blockers", async () => {
    const { navigator, history } = rig([about]);
    let blocked = 0;
    history.block(() => {
      blocked += 1;
    });
    await navigator.preload("/about");
    expect(blocked).toBe(0);
  });

  it("[I-N4] preload swallows its errors and reports them to onError", async () => {
    const { navigator, errors } = rig([
      { id: "x", path: "/x", loader: () => Promise.reject(new Error("preload failed")) },
    ]);
    await expect(navigator.preload("/x")).resolves.toBeUndefined();
    expect(errors.map((error) => (error as Error).message)).toEqual(["preload failed"]);
  });

  it("[I-L1] preload runs beforeLoad, so it cannot bypass a guard", async () => {
    let guarded = 0;
    const { navigator } = rig([
      {
        id: "private",
        path: "/private",
        beforeLoad: () => {
          guarded += 1;
          throw redirect("/login");
        },
      },
    ]);
    await navigator.preload("/private");
    expect(guarded).toBe(1);
  });

  it("[I-N4] a redirect found while preloading is ignored", async () => {
    const { navigator, history } = rig([
      {
        id: "old",
        path: "/old",
        beforeLoad: () => {
          throw redirect("/new");
        },
      },
      { id: "new", path: "/new" },
    ]);
    await navigator.preload("/old");
    expect(history.location.pathname).toBe("/");
  });

  it("[I-N5] a navigation shares the flight of an earlier preload", async () => {
    const gate = deferred<string>();
    let calls = 0;
    const { navigator, cache } = rig([
      {
        id: "item",
        path: "/items/:id",
        loader: () => {
          calls += 1;
          return gate.promise;
        },
      },
    ]);
    const preloading = navigator.preload("/items/1");
    const navigating = navigator.navigate("/items/1");
    await settle();
    expect(calls).toBe(1);
    expect(cache.inFlight).toBe(1);
    gate.resolve("shared");
    await preloading;
    expect(kindOf(await navigating)).toBe("success");
    expect(navigator.getSnapshot().matches[0]?.loaderData).toBe("shared");
  });
});

describe("navigation: state machine, pending and snapshot", () => {
  it("[I-N6] status goes matching, beforeLoad, loading, committing, then idle", async () => {
    const seen: string[] = [];
    const gate = deferred<string>();
    const { navigator } = rig([
      {
        id: "x",
        path: "/x",
        beforeLoad: () => {
          seen.push(navigator.getSnapshot().status);
        },
        loader: () => {
          seen.push(navigator.getSnapshot().status);
          return gate.promise;
        },
      },
    ]);
    const pending = navigator.navigate("/x");
    await settle();
    expect(seen).toEqual(["beforeLoad", "loading"]);
    gate.resolve("v");
    await pending;
    expect(navigator.getSnapshot().status).toBe("idle");
  });

  it("[I-N6] an exception in a subscriber cannot leave the navigator stuck", async () => {
    const { navigator, errors } = rig([{ id: "x", path: "/x" }]);
    navigator.subscribe(() => {
      throw new Error("commit hook broke");
    });
    const outcome = await navigator.navigate("/x");
    expect(kindOf(outcome)).toBe("success");
    expect(navigator.getSnapshot().status).toBe("idle");
    expect(navigator.getSnapshot().pending).toBe(false);
    expect(errors.map((error) => (error as Error).message)).toContain("commit hook broke");
    expect(kindOf(await navigator.navigate("/x?again=1"))).toBe("success");
  });

  it("[I-N6] a loader that throws leaves status idle and pending false", async () => {
    const { navigator } = rig([
      { id: "x", path: "/x", loader: () => Promise.reject(new Error("no")) },
    ]);
    await navigator.navigate("/x");
    expect(navigator.getSnapshot().status).toBe("idle");
    expect(navigator.getSnapshot().pending).toBe(false);
  });

  it("[I-L7] a fast load never shows pending", async () => {
    const gate = deferred<string>();
    const { navigator, clock } = rig([{ id: "x", path: "/x", loader: () => gate.promise }]);
    const pending = navigator.navigate("/x");
    clock.advance(900);
    gate.resolve("fast");
    await pending;
    clock.advance(10_000);
    expect(navigator.getSnapshot().pending).toBe(false);
    expect(navigator.getSnapshot().status).toBe("idle");
  });

  it("[I-L7] pending appears after pendingMs and stays for at least pendingMinMs", async () => {
    const gate = deferred<string>();
    const clock = createFakeClock(0);
    const history = createMemoryHistory({ scheduleFlush: (run) => run() });
    const navigator = createNavigator({
      routes: [{ id: "x", path: "/x", loader: () => gate.promise }],
      history,
      loaderCache: createLoaderCache({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      pendingMs: 1000,
      pendingMinMs: 500,
    });
    const pending = navigator.navigate("/x");
    clock.advance(999);
    expect(navigator.getSnapshot().pending).toBe(false);
    clock.advance(1);
    expect(navigator.getSnapshot().pending).toBe(true);
    clock.advance(200);
    gate.resolve("slow");
    await pending;
    expect(navigator.getSnapshot().pending).toBe(true);
    clock.advance(299);
    expect(navigator.getSnapshot().pending).toBe(true);
    clock.advance(1);
    expect(navigator.getSnapshot().pending).toBe(false);
  });

  it("[I-L7] a navigation that starts during the minimum display time keeps pending until it finishes", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const clock = createFakeClock(0);
    const history = createMemoryHistory({ scheduleFlush: (run) => run() });
    const navigator = createNavigator({
      routes: [
        { id: "one", path: "/one", loader: () => first.promise },
        { id: "two", path: "/two", loader: () => second.promise },
      ],
      history,
      loaderCache: createLoaderCache({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      pendingMs: 1000,
      pendingMinMs: 500,
    });
    const firstRun = navigator.navigate("/one");
    clock.advance(1000);
    expect(navigator.getSnapshot().pending).toBe(true);
    first.resolve("a");
    await firstRun;
    const secondRun = navigator.navigate("/two");
    clock.advance(600);
    expect(navigator.getSnapshot().status).toBe("loading");
    expect(navigator.getSnapshot().pending).toBe(true);
    second.resolve("b");
    await secondRun;
    expect(navigator.getSnapshot().pending).toBe(false);
  });

  it("[I-L7] a stale-while-revalidate hit never flashes pending", async () => {
    let calls = 0;
    const { navigator, clock } = rig(
      [{ id: "x", path: "/x", loader: () => new Promise<number>((resolve) => resolve(++calls)) }],
      { staleTime: 0 },
    );
    await navigator.navigate("/x");
    const seen: boolean[] = [];
    navigator.subscribe((snapshot) => {
      seen.push(snapshot.pending);
    });
    await navigator.navigate("/x");
    clock.advance(5_000);
    expect(seen.every((flag) => flag === false)).toBe(true);
    expect(navigator.getSnapshot().matches[0]?.loaderData).toBe(1);
  });

  it("subscribe delivers snapshots, and getSnapshot is stable while nothing changes", async () => {
    const { navigator, snapshots } = rig([home, about]);
    await navigator.navigate("/about");
    const first = navigator.getSnapshot();
    expect(navigator.getSnapshot()).toBe(first);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1]).toBe(first);
  });

  it("unsubscribe stops delivery", async () => {
    const { navigator } = rig([home, about]);
    let count = 0;
    const stop = navigator.subscribe(() => {
      count += 1;
    });
    stop();
    await navigator.navigate("/about");
    expect(count).toBe(0);
  });

  it("[I-M1] repeated navigation keeps only the latest snapshot and no extra state", async () => {
    const { navigator } = rig([home]);
    for (let step = 0; step < 300; step += 1) {
      await navigator.navigate(`/?step=${step}`);
    }
    expect(navigator.getSnapshot().location?.search).toBe("?step=299");
  });
});

describe("navigation: history integration", () => {
  it("[I-N9] a blocked navigation returns blocked and leaves the location alone", async () => {
    const { navigator, history } = rig([home, about]);
    history.block(() => undefined);
    const outcome = await navigator.navigate("/about");
    expect(kindOf(outcome)).toBe("blocked");
    expect(history.location.pathname).toBe("/");
    expect(navigator.getSnapshot().location?.pathname).toBe("/");
  });

  it("[I-N7] an external back is handled as a navigation that does not write history", async () => {
    let loads = 0;
    const { navigator, history } = rig([
      home,
      { id: "about", path: "/about", loader: () => ++loads },
    ]);
    await navigator.navigate("/about");
    history.back();
    await settle();
    expect(navigator.getSnapshot().location?.pathname).toBe("/");
    expect(navigator.getSnapshot().matches.map((match) => match.id)).toEqual(["home"]);
    history.flush();
    expect(history.length).toBe(2);
    expect(loads).toBe(1);
  });

  it("[I-N12] the navigator ignores its own history write", async () => {
    let loads = 0;
    const { navigator } = rig([{ id: "about", path: "/about", loader: () => ++loads }]);
    await navigator.navigate("/about");
    expect(loads).toBe(1);
  });

  it("an external push is treated as a navigation", async () => {
    const { navigator, history } = rig([home, about]);
    history.push("/about");
    await settle();
    expect(navigator.getSnapshot().location?.pathname).toBe("/about");
  });

  it("[I-M2] destroy stops listening to history and aborts in-flight work", async () => {
    const gate = deferred<string>();
    let seen: AbortSignal | undefined;
    const { navigator, history } = rig([
      home,
      about,
      {
        id: "slow",
        path: "/slow",
        loader: (args) => {
          seen = args.signal;
          return gate.promise;
        },
      },
    ]);
    const pending = navigator.navigate("/slow");
    await settle();
    navigator.destroy();
    expect(seen?.aborted).toBe(true);
    expect(kindOf(await pending)).toBe("canceled");
    history.push("/about");
    await settle();
    expect(navigator.getSnapshot().location?.pathname).toBe("/");
  });

  it("[I-U13] the always policy commits the trailing slash", async () => {
    const { navigator, history } = rig([about], { trailingSlash: "always" });
    await navigator.navigate("/about");
    expect(history.location.pathname).toBe("/about/");
  });
});

describe("navigation: construction", () => {
  it("rejects duplicate route ids", () => {
    const clock = createFakeClock(0);
    expect(() =>
      createNavigator({
        routes: [
          { id: "dup", path: "/a" },
          { id: "dup", path: "/b" },
        ],
        history: createMemoryHistory(),
        loaderCache: createLoaderCache({
          now: clock.now,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        }),
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }),
    ).toThrow(/dup/);
  });

  it("rejects ambiguous routes at construction", () => {
    const clock = createFakeClock(0);
    expect(() =>
      createNavigator({
        routes: [
          { id: "a", path: "/x/:id" },
          { id: "b", path: "/x/:name" },
        ],
        history: createMemoryHistory(),
        loaderCache: createLoaderCache({
          now: clock.now,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        }),
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }),
    ).toThrow(/ambiguous|a.*b/i);
  });
});
