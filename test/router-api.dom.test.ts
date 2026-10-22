import { describe, expect, it } from "vitest";
import { PatternSyntaxError } from "../src/core/index";
import { loaderCache } from "../src/features/loaders";
import {
  createMemoryHistory,
  createRouter,
  defineRoute,
  isNotFound,
  notFound,
  parseHydrationData,
  redirect,
  serializeHydrationData,
} from "../src/index";
import { everyFeature, featuresWith } from "./support/features";
import { rig, settle } from "./support/rig";
import { RouterTestWindow } from "./support/router-window";

/** A route whose loader records how often it ran and with what. */
function counted<T>(calls: unknown[], value: (params: Record<string, string>) => T) {
  return (args: { params: Record<string, string> }) => {
    calls.push(args.params);
    return value(args.params);
  };
}

describe("createRouter: navigation outcomes", () => {
  it("[API-01 I-L1] ready() loads the current location and reports success", async () => {
    const r = rig([defineRoute("/", {})]);
    const outcome = await r.router.ready();
    expect(outcome.kind).toBe("success");
    expect(r.router.state.matches().map((m) => m.id)).toEqual(["/"]);
    r.router.dispose();
  });

  it("[API-02 I-L1] ready() is idempotent: the same promise on every call", () => {
    const r = rig([defineRoute("/", {})]);
    expect(r.router.ready()).toBe(r.router.ready());
    r.router.dispose();
  });

  it("[API-03 I-N3] navigate() resolves with success and commits params", async () => {
    const r = rig([defineRoute("/posts/:id", {})]);
    const outcome = await r.router.navigate("/posts/7");
    expect(outcome.kind).toBe("success");
    expect(r.router.state.matches()[0]?.params).toEqual({ id: "7" });
    expect(r.router.state.location()?.pathname).toBe("/posts/7");
    r.router.dispose();
  });

  it("[API-04 I-N2] an unmatched target resolves with notFound and no route matches", async () => {
    const r = rig([defineRoute("/", {})]);
    const outcome = await r.router.navigate("/nope/deep");
    expect(outcome.kind).toBe("notFound");
    expect(isNotFound(r.router.state.error())).toBe(true);
    expect(r.router.state.matches()).toEqual([]);
    r.router.dispose();
  });

  it("[API-05 I-L9] a notFound thrown by a loader resolves notFound and names its route", async () => {
    const r = rig([
      defineRoute("/posts/:id", {
        loader: () => {
          throw notFound();
        },
      }),
    ]);
    const outcome = await r.router.navigate("/posts/1");
    expect(outcome.kind).toBe("notFound");
    expect(isNotFound(r.router.state.error())).toBe(true);
    r.router.dispose();
  });

  it("[API-06 I-N3] a beforeLoad redirect lands on the target as the pushed entry", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/login", {}),
      defineRoute("/private", {
        beforeLoad: () => {
          throw redirect("/login");
        },
      }),
    ]);
    await r.router.ready();
    const before = r.win.entryCount;
    const outcome = await r.router.navigate("/private");
    expect(outcome.kind).toBe("success");
    expect(r.router.state.location()?.pathname).toBe("/login");
    expect(r.win.entryCount).toBe(before + 1);
    r.router.dispose();
  });

  it("[API-06b I-N3] a redirect from a replacing navigation keeps the entry count", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/login", {}),
      defineRoute("/private", {
        beforeLoad: () => {
          throw redirect("/login");
        },
      }),
    ]);
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/private", { replace: true });
    expect(r.win.entryCount).toBe(before);
    expect(r.router.state.location()?.pathname).toBe("/login");
    r.router.dispose();
  });
  it("[API-07 I-N3] a loader redirect with replace false pushes an entry", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/there", {}),
      defineRoute("/start", {
        loader: () => {
          throw redirect("/there", { replace: false });
        },
      }),
    ]);
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/start");
    expect(r.router.state.location()?.pathname).toBe("/there");
    expect(r.win.entryCount).toBe(before + 1);
    r.router.dispose();
  });

  it("[API-08 I-N2] redirects are followed in order and end at the target", async () => {
    const r = rig([
      defineRoute("/a", {
        beforeLoad: () => {
          throw redirect("/b");
        },
      }),
      defineRoute("/b", {
        beforeLoad: () => {
          throw redirect("/c");
        },
      }),
      defineRoute("/c", {}),
    ]);
    const outcome = await r.router.navigate("/a");
    expect(outcome.kind).toBe("success");
    expect(r.router.state.location()?.pathname).toBe("/c");
    r.router.dispose();
  });

  it("[API-09 I-N2] an endless redirect loop stops at maxRedirects with an error", async () => {
    const r = rig(
      [
        defineRoute("/a", {
          beforeLoad: () => {
            throw redirect("/b");
          },
        }),
        defineRoute("/b", {
          beforeLoad: () => {
            throw redirect("/a");
          },
        }),
      ],
      { maxRedirects: 3 },
    );
    const outcome = await r.router.navigate("/a");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(String(outcome.error)).toMatch(/redirect limit of 3/);
    r.router.dispose();
  });

  it("[API-10 I-L1] a beforeLoad error fails the navigation and commits nothing", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/bad", {
        beforeLoad: () => {
          throw new Error("denied");
        },
      }),
    ]);
    await r.router.ready();
    const outcome = await r.router.navigate("/bad");
    expect(outcome.kind).toBe("error");
    expect(r.router.state.location()?.pathname).toBe("/");
    expect(r.router.state.matches().map((m) => m.id)).toEqual(["/"]);
    r.router.dispose();
  });

  it("[API-11 I-L9] a loader error commits the location; the match carries the failure", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/boom", {
        loader: () => {
          throw new Error("db down");
        },
      }),
    ]);
    await r.router.ready();
    const outcome = await r.router.navigate("/boom");
    expect(outcome.kind).toBe("success");
    expect(r.router.state.location()?.pathname).toBe("/boom");
    const data = r.router.dehydrate();
    expect(data.matches.map((m) => m.failed)).toEqual([true]);
    r.router.dispose();
  });

  it("[API-12 I-S4] a validateSearch error fails the navigation", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/list", {
        validateSearch: (search) => {
          if (search["page"] === undefined) throw new TypeError("page is required");
          return search;
        },
      }),
    ]);
    await r.router.ready();
    const outcome = await r.router.navigate("/list");
    expect(outcome.kind).toBe("error");
    r.router.dispose();
  });

  it("[API-13 I-S1] a query longer than maxSearchLength is an error, not a parse", async () => {
    const r = rig([defineRoute("/", {})], { maxSearchLength: 8 });
    await r.router.ready();
    const outcome = await r.router.navigate("/?a=1234567890");
    expect(outcome.kind).toBe("error");
    r.router.dispose();
  });

  it("[API-14 I-N1] the last of two navigations started in one tick is the one that commits", async () => {
    const r = rig([defineRoute("/", {}), defineRoute("/a", {}), defineRoute("/b", {})]);
    await r.router.ready();
    const first = r.router.navigate("/a");
    const second = r.router.navigate("/b");
    await Promise.all([first, second]);
    expect(r.router.state.location()?.pathname).toBe("/b");
    r.router.dispose();
  });

  it("[API-15 I-N6] a navigation after dispose resolves as canceled", async () => {
    const r = rig([defineRoute("/", {})]);
    await r.router.ready();
    r.router.dispose();
    const outcome = await r.router.navigate("/");
    expect(outcome.kind).toBe("canceled");
  });
});

describe("createRouter: search, base and trailing slashes", () => {
  it("[API-20 I-S4] the query is parsed once and handed to validateSearch and the loader", async () => {
    const seen: unknown[] = [];
    const r = rig([
      defineRoute("/posts", {
        validateSearch: (search) => ({ page: Number(search["page"] ?? 1) }),
        loader: ({ search }) => {
          seen.push(search);
          return null;
        },
      }),
    ]);
    await r.router.navigate("/posts?page=3&tag=a&tag=b");
    expect(seen).toEqual([{ page: 3 }]);
    r.router.dispose();
  });

  it("[API-21 I-S3] duplicate keys become arrays and valueless keys become true", async () => {
    const r = rig([defineRoute("/", {})]);
    await r.router.navigate("/?tag=a&tag=b&flag");
    expect(r.win.location.search).toBe("?tag=a&tag=b&flag");
    r.router.dispose();
  });

  it("[API-22 I-U9] a base path is added once to targets and matched at segment boundaries", async () => {
    const r = rig([defineRoute("/posts", {})], { url: "/app/posts", base: "/app" });
    const outcome = await r.router.ready();
    expect(outcome.kind).toBe("success");
    expect(r.router.state.matches().map((m) => m.id)).toEqual(["/posts"]);
    expect(r.router.href("/posts")).toBe("/app/posts");
    r.router.dispose();
  });

  it("[API-23 I-U9] /application is not claimed by a base of /app", async () => {
    const r = rig([defineRoute("/", {})], { url: "/application", base: "/app" });
    const outcome = await r.router.ready();
    expect(outcome.kind).toBe("notFound");
    r.router.dispose();
  });

  it("[API-24 I-U13] trailing slash 'always' writes the slash into the location", async () => {
    const r = rig([defineRoute("/posts", {})], { trailingSlash: "always" });
    await r.router.navigate("/posts");
    expect(r.win.location.pathname).toBe("/posts/");
    r.router.dispose();
  });

  it("[API-25 I-U13] trailing slash 'never' removes it and matches the same route", async () => {
    const r = rig([defineRoute("/posts", {})]);
    await r.router.navigate("/posts/");
    expect(r.win.location.pathname).toBe("/posts");
    expect(r.router.state.matches()[0]?.id).toBe("/posts");
    r.router.dispose();
  });

  it("[API-26 I-U1] empty interior segments never match", async () => {
    const r = rig([defineRoute("/a/b", {})]);
    const outcome = await r.router.navigate("/a//b");
    expect(outcome.kind).toBe("notFound");
    r.router.dispose();
  });
});

describe("createRouter: href and target building", () => {
  it("[API-30 I-U3] href fills params and encodes them", () => {
    const r = rig([defineRoute("/posts/:id", {})]);
    expect(r.router.href("/posts/:id", { params: { id: "a b/c" } })).toBe("/posts/a%20b%2Fc");
    r.router.dispose();
  });

  it("[API-31 I-U3] href throws a RangeError for a missing required param", () => {
    const r = rig([defineRoute("/posts/:id", {})]);
    expect(() => r.router.href("/posts/:id", { params: {} })).toThrow(RangeError);
    r.router.dispose();
  });

  it("[API-32 I-S5] search objects merge onto the target's query and remove undefined keys", async () => {
    const r = rig([defineRoute("/list", {})]);
    expect(r.router.href("/list?a=1&b=2", { search: { b: undefined, c: "x y" } })).toBe(
      "/list?a=1&c=x%20y",
    );
    r.router.dispose();
  });

  it("[API-33 I-U12] a hash option is written with or without the leading #", () => {
    const r = rig([defineRoute("/doc", {})]);
    expect(r.router.href("/doc", { hash: "top" })).toBe("/doc#top");
    expect(r.router.href("/doc", { hash: "#intro" })).toBe("/doc#intro");
    expect(r.router.href("/doc", { hash: "" })).toBe("/doc");
    r.router.dispose();
  });

  it("[API-34 I-N13] a relative query-only target keeps the current pathname", async () => {
    const r = rig([defineRoute("/list", {})], { url: "/list?page=1" });
    await r.router.ready();
    expect(r.router.href("?page=2")).toBe("/list?page=2");
    r.router.dispose();
  });

  it("[API-35 I-U10] an absolute URL is returned unchanged and is not routed", () => {
    const r = rig([defineRoute("/", {})]);
    expect(r.router.href("https://example.test/x")).toBe("https://example.test/x");
    r.router.dispose();
  });

  it("[API-36 I-U10] an unsafe scheme is not routed", async () => {
    const r = rig([defineRoute("/", {})]);
    const outcome = await r.router.navigate("javascript:alert(1)");
    expect(outcome.kind).toBe("error");
    expect(r.win.location.pathname).toBe("/");
    r.router.dispose();
  });

  it("[API-37 I-N12] navigate applies params and search together", async () => {
    const r = rig([defineRoute("/posts/:id", {})]);
    await r.router.navigate("/posts/:id", { params: { id: "9" }, search: { tab: "notes" } });
    expect(r.win.location.pathname).toBe("/posts/9");
    expect(r.win.location.search).toBe("?tab=notes");
    r.router.dispose();
  });

  it("[API-38 I-N8] navigate stores the state object on the new entry", async () => {
    const r = rig([defineRoute("/", {}), defineRoute("/x", {})]);
    await r.router.ready();
    await r.router.navigate("/x", { state: { from: "home" } });
    expect(r.win.currentState()).toMatchObject({ __shadowState: { from: "home" } });
    r.router.dispose();
  });

  it("[API-39 I-N8] replace keeps the number of entries", async () => {
    const r = rig([defineRoute("/", {}), defineRoute("/x", {})]);
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/x", { replace: true });
    expect(r.win.entryCount).toBe(before);
    r.router.dispose();
  });

  it("[API-40 I-N8] a push adds exactly one entry", async () => {
    const r = rig([defineRoute("/", {}), defineRoute("/x", {})]);
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/x");
    expect(r.win.entryCount).toBe(before + 1);
    r.router.dispose();
  });
});

describe("createRouter: loaders and context", () => {
  it("[API-50 I-L2] the loader receives params, search, deps and intent", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r = rig([
      defineRoute("/posts/:id", {
        validateSearch: (search) => ({ page: Number(search["page"] ?? 1) }),
        loaderDeps: (search) => ({ page: search.page }),
        loader: ({ params, search, deps, intent }) => {
          seen.push({ params, search, deps, intent });
          return null;
        },
      }),
    ]);
    await r.router.navigate("/posts/4?page=2");
    expect(seen).toEqual([
      { params: { id: "4" }, search: { page: 2 }, deps: { page: 2 }, intent: "navigate" },
    ]);
    r.router.dispose();
  });

  it("[API-51 I-L1] beforeLoad context accumulates from the root down to the leaf", async () => {
    const seen: unknown[] = [];
    const r = rig([
      defineRoute("", {
        id: "root",
        beforeLoad: () => ({ user: "ada" }),
        children: [
          defineRoute("/x", {
            id: "x",
            beforeLoad: ({ context }) => ({ role: `${String(context["user"])}-admin` }),
            loader: ({ context }) => {
              seen.push(context);
              return null;
            },
          }),
        ],
      }),
    ]);
    await r.router.navigate("/x");
    expect(seen).toEqual([{ user: "ada", role: "ada-admin" }]);
    r.router.dispose();
  });

  it("[API-52 I-L3] a context addition named like an object prototype key is dropped", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r = rig([
      defineRoute("", {
        id: "root",
        beforeLoad: () => ({ constructor: "evil", ok: 1 }),
        children: [
          defineRoute("/y", {
            id: "y",
            loader: ({ context }) => {
              seen.push({ ...context, own: Object.hasOwn(context, "constructor") });
              return null;
            },
          }),
        ],
      }),
    ]);
    const outcome = await r.router.navigate("/y");
    expect(outcome.kind).toBe("success");
    expect(seen).toEqual([{ ok: 1, own: false }]);
    r.router.dispose();
  });

  it("[API-53 I-L4] loader results are cached: a second navigation to the same target does not reload", async () => {
    const calls: unknown[] = [];
    const r = rig(
      [defineRoute("/", {}), defineRoute("/p/:id", { loader: counted(calls, (p) => p["id"]) })],
      {
        features: featuresWith(loaderCache({ staleTime: 60_000 })),
      },
    );
    await r.router.navigate("/p/1");
    await r.router.navigate("/");
    await r.router.navigate("/p/1");
    expect(calls).toHaveLength(1);
    r.router.dispose();
  });

  it("[API-54 I-L7] with the default staleTime (0) every navigation refetches", async () => {
    const calls: unknown[] = [];
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/p/:id", { loader: counted(calls, (p) => p["id"]) }),
    ]);
    await r.router.navigate("/p/1");
    await r.router.navigate("/p/1");
    expect(calls).toHaveLength(2);
    r.router.dispose();
  });

  it("[API-55 I-L4] invalidate() reloads the current location with a fresh loader run", async () => {
    const calls: unknown[] = [];
    const r = rig([defineRoute("/p/:id", { loader: counted(calls, (p) => p["id"]) })], {
      features: featuresWith(loaderCache({ staleTime: 60_000 })),
    });
    await r.router.navigate("/p/5");
    await r.router.invalidate();
    expect(calls).toHaveLength(2);
    r.router.dispose();
  });

  it("[API-56 I-L4] invalidate({ routeId }) only marks that route", async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const r = rig(
      [
        defineRoute("", {
          id: "shell",
          loader: counted(a, () => 1),
          children: [defineRoute("/leaf", { id: "leaf", loader: counted(b, () => 2) })],
        }),
      ],
      { features: featuresWith(loaderCache({ staleTime: 60_000 })) },
    );
    await r.router.navigate("/leaf");
    await r.router.invalidate({ routeId: "leaf" });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    r.router.dispose();
  });

  it("[API-57 I-N4] a preload warms the cache without changing the location or the history", async () => {
    const calls: unknown[] = [];
    const r = rig(
      [defineRoute("/", {}), defineRoute("/p/:id", { loader: counted(calls, () => 1) })],
      {
        features: featuresWith(loaderCache({ staleTime: 60_000 })),
      },
    );
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.preload("/p/3");
    expect(r.win.location.pathname).toBe("/");
    expect(r.win.entryCount).toBe(before);
    await r.router.navigate("/p/3");
    expect(calls).toHaveLength(1);
    r.router.dispose();
  });

  it("[API-58 I-N4] a preload never reports a loader error and never commits it", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/p", {
        loader: () => {
          throw new Error("offline");
        },
      }),
    ]);
    await r.router.ready();
    await r.router.preload("/p");
    expect(r.errors).toEqual([]);
    expect(r.win.location.pathname).toBe("/");
    r.router.dispose();
  });

  it("[API-59 I-N4] a preload that fails before loading is reported through onError", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/p", {
        beforeLoad: () => {
          throw new Error("guard exploded");
        },
      }),
    ]);
    await r.router.ready();
    await r.router.preload("/p");
    expect(r.errors).toHaveLength(1);
    r.router.dispose();
  });

  it("[API-60 I-N1] a loader receives an AbortSignal that is aborted when the navigation is superseded", async () => {
    let signal: AbortSignal | undefined;
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/slow", {
        loader: (args) => {
          signal = args.signal;
          return new Promise<void>(() => undefined);
        },
      }),
      defineRoute("/fast", {}),
    ]);
    await r.router.ready();
    void r.router.navigate("/slow");
    await settle();
    await r.router.navigate("/fast");
    expect(signal?.aborted).toBe(true);
    r.router.dispose();
  });
});

describe("createRouter: definitions", () => {
  it("[API-70 I-U14] a pathless route needs an explicit id", () => {
    expect(() => defineRoute("", {})).toThrow(TypeError);
    expect(defineRoute("", { id: "layout" }).id).toBe("layout");
  });

  it("[API-71 I-U14] an invalid pattern throws when the route is defined", () => {
    expect(() => defineRoute("/a/:id/:id", {})).toThrow(PatternSyntaxError);
    expect(() => defineRoute("/a/*rest/b", {})).toThrow(PatternSyntaxError);
  });

  it("[API-72 I-U14] two routes with the same id are rejected", () => {
    expect(() =>
      createRouter({
        features: everyFeature(),
        routes: [defineRoute("/a", { id: "dup" }), defineRoute("/b", { id: "dup" })],
      }),
    ).toThrow(TypeError);
  });

  it("[API-73 I-U14] two routes that match the same paths are rejected with a conflict error", () => {
    expect(() =>
      createRouter({
        features: everyFeature(),
        routes: [defineRoute("/posts/:id", {}), defineRoute("/posts/:slug", {})],
        history: createMemoryHistory({ initialEntries: ["/"] }),
      }),
    ).toThrow(/route conflicts/);
  });

  it("[API-74 I-U7] children use paths relative to their parent", async () => {
    const r = rig([defineRoute("/posts", { children: [defineRoute("/:id", {})] })]);
    await r.router.navigate("/posts/12");
    // A child's default id is its own path; `from` takes that id.
    expect(r.router.state.matches().map((m) => m.id)).toEqual(["/posts", "/:id"]);
    r.router.dispose();
  });

  it("[API-75 I-U7] five nested levels accumulate their params", async () => {
    const level5 = defineRoute("/e/:p5", {});
    const level4 = defineRoute("/d/:p4", { children: [level5] });
    const level3 = defineRoute("/c/:p3", { children: [level4] });
    const level2 = defineRoute("/b/:p2", { children: [level3] });
    const level1 = defineRoute("/a/:p1", { children: [level2] });
    const r = rig([level1]);
    await r.router.navigate("/a/1/b/2/c/3/d/4/e/5");
    const matches = r.router.state.matches();
    expect(matches).toHaveLength(5);
    expect(matches.map((m) => m.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(matches[4]?.params).toEqual({ p1: "1", p2: "2", p3: "3", p4: "4", p5: "5" });
    r.router.dispose();
  });

  it("[API-76 I-U7] a pathless layout matches the paths of its children", async () => {
    const r = rig([defineRoute("", { id: "shell", children: [defineRoute("/x", { id: "x" })] })]);
    await r.router.navigate("/x");
    expect(r.router.state.matches().map((m) => m.id)).toEqual(["shell", "x"]);
    r.router.dispose();
  });

  it("[API-77 I-U7] a route with children matches only through its leaves", async () => {
    const r = rig([defineRoute("/posts", { children: [defineRoute("/:id", {})] })]);
    const outcome = await r.router.navigate("/posts");
    expect(outcome.kind).toBe("notFound");
    r.router.dispose();
  });

  it("[API-78 I-U7] the route id defaults to the path and is exposed on the definition", () => {
    const route = defineRoute("/about", {});
    expect(route.id).toBe("/about");
    expect(route.path).toBe("/about");
  });
});

describe("createRouter: state accessors", () => {
  it("[API-80 I-N6] status is idle once a navigation has committed", async () => {
    const r = rig([defineRoute("/", {})]);
    await r.router.ready();
    expect(r.router.state.status()).toBe("idle");
    r.router.dispose();
  });

  it("[API-81 I-N6] pending is false for a fast navigation", async () => {
    const r = rig([defineRoute("/", {}), defineRoute("/x", {})]);
    await r.router.navigate("/x");
    expect(r.router.state.pending()).toBe(false);
    r.router.dispose();
  });

  it("[API-82 I-L8] error() holds the notFound signal after a not-found navigation", async () => {
    const r = rig([defineRoute("/", {})]);
    await r.router.navigate("/missing");
    expect(isNotFound(r.router.state.error())).toBe(true);
    r.router.dispose();
  });

  it("[API-83 I-U6] state.location() is undefined before the first load in a fresh router", () => {
    const r = rig([defineRoute("/", {})]);
    expect(r.router.state.location()?.pathname).toBe("/");
    r.router.dispose();
  });
});

describe("createRouter: hydration data", () => {
  it("[API-90 I-L10] dehydrate lists the loaded matches with their updatedAt and params", async () => {
    const r = rig([defineRoute("/p/:id", { loader: ({ params }) => ({ id: params["id"] }) })]);
    await r.router.navigate("/p/8");
    const data = r.router.dehydrate();
    expect(data.version).toBe(1);
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({
      id: "/p/:id",
      params: { id: "8" },
      value: { id: "8" },
      failed: false,
    });
    r.router.dispose();
  });

  it("[API-91 I-L10] hydrate + ready uses the seeded data: the loader does not run again", async () => {
    const server = rig(
      [defineRoute("/p/:id", { loader: ({ params }) => ({ id: params["id"] }) })],
      {
        url: "/p/3",
      },
    );
    await server.router.ready();
    const data = JSON.parse(JSON.stringify(server.router.dehydrate())) as unknown;
    server.router.dispose();

    const calls: unknown[] = [];
    const client = rig(
      [defineRoute("/p/:id", { loader: counted(calls, (p) => ({ id: p["id"] })) })],
      {
        url: "/p/3",
      },
    );
    client.router.hydrate(parseHydrationData(JSON.stringify(data)));
    const outcome = await client.router.ready();
    expect(outcome.kind).toBe("success");
    expect(calls).toEqual([]);
    expect(client.router.state.matches()[0]?.loaderData).toEqual({ id: "3" });
    client.router.dispose();
  });

  it("[API-92 I-L10] a failed loader survives the round trip as a failure, not as data", async () => {
    const server = rig(
      [
        defineRoute("/bad", {
          loader: () => {
            throw new Error("nope");
          },
        }),
      ],
      { url: "/bad" },
    );
    await server.router.ready();
    const data = server.router.dehydrate();
    server.router.dispose();
    expect(data.matches[0]?.failed).toBe(true);
    const client = rig([defineRoute("/bad", { loader: () => ({ ok: true }) })], { url: "/bad" });
    client.router.hydrate(data);
    await client.router.ready();
    expect(client.router.dehydrate().matches[0]?.failed).toBe(true);
    client.router.dispose();
  });

  it("[API-93 I-F11] hydrate rejects data of another version", () => {
    const r = rig([defineRoute("/", {})]);
    expect(() => r.router.hydrate({ version: 2, matches: [] } as never)).toThrow(TypeError);
    r.router.dispose();
  });

  it("[API-94 I-F11] serialized hydration data cannot end its script element", () => {
    const text = serializeHydrationData({
      version: 1,
      matches: [
        {
          id: "/x",
          params: {},
          deps: undefined,
          updatedAt: 1,
          value: "</script><b>&",
          failed: false,
        },
      ],
    });
    expect(text).not.toContain("</script>");
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text).not.toContain("&");
    expect(parseHydrationData(text).matches[0]?.value).toBe("</script><b>&");
  });

  it("[API-95 I-F11] parseHydrationData refuses text that is not hydration data", () => {
    expect(() => parseHydrationData("[1,2]")).toThrow(TypeError);
    expect(() => parseHydrationData('{"version":1,"matches":"x"}')).toThrow(TypeError);
  });
});

describe("createRouter: lifecycle", () => {
  it("[API-100 I-M2] dispose removes every listener the router added to the window", async () => {
    const r = rig([defineRoute("/", {})]);
    await r.router.ready();
    expect(r.win.activeListeners).toBeGreaterThan(0);
    r.router.dispose();
    expect(r.win.activeListeners).toBe(0);
  });

  it("[API-101 I-M2] dispose cancels a pending timer and leaves no timer behind", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/slow", { loader: () => new Promise<void>(() => undefined) }),
    ]);
    await r.router.ready();
    void r.router.navigate("/slow");
    await settle();
    expect(r.clock.pendingTimers).toBeGreaterThan(0);
    r.router.dispose();
    expect(r.clock.pendingTimers).toBe(0);
  });

  it("[API-102 I-M2] dispose is idempotent", () => {
    const r = rig([defineRoute("/", {})]);
    r.router.dispose();
    expect(() => r.router.dispose()).not.toThrow();
  });

  it("[API-103 I-M1] a thousand navigations leave the listener and timer counts where they started", async () => {
    const r = rig([defineRoute("/", {}), defineRoute("/p/:id", { loader: () => 1 })]);
    await r.router.ready();
    const listeners = r.win.activeListeners;
    for (let n = 0; n < 1000; n += 1) {
      await r.router.navigate(`/p/${n}`);
    }
    expect(r.win.activeListeners).toBe(listeners);
    expect(r.clock.pendingTimers).toBeLessThanOrEqual(1);
    r.router.dispose();
  });

  it("[API-104 I-M2] a memory router without a window registers nothing on it", async () => {
    const win = new RouterTestWindow("/");
    const router = createRouter({
      features: everyFeature(),
      routes: [defineRoute("/", {}), defineRoute("/x", {})],
      history: createMemoryHistory({ initialEntries: ["/"] }),
      window: win,
    });
    await router.navigate("/x");
    expect(win.added).toEqual(["pagehide", "wheel", "touchstart"]);
    router.dispose();
    expect(win.activeListeners).toBe(0);
  });
});
