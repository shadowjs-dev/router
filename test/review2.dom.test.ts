import { describe, expect, it } from "vitest";
import { buildPath, buildPathFromParams } from "../src/core/index";
import { defineRoute, redirect } from "../src/index";
import { rig } from "./support/rig";

/** Review round two. */

describe("redirect(): an explicit replace is honored", () => {
  function routes(signal: () => unknown) {
    return [
      defineRoute("/", {}),
      defineRoute("/login", {}),
      defineRoute("/private", {
        beforeLoad: () => {
          throw signal();
        },
      }),
    ];
  }

  it("[RTR-R2-11] replace: true replaces the entry although the navigation pushes", async () => {
    const r = rig(routes(() => redirect("/login", { replace: true })));
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/private");
    expect(r.router.state.location()?.pathname).toBe("/login");
    expect(r.win.entryCount).toBe(before);
    r.router.dispose();
  });

  it("[RTR-R2-11] replace: false pushes an entry although the navigation replaces", async () => {
    const r = rig(routes(() => redirect("/login", { replace: false })));
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/private", { replace: true });
    expect(r.router.state.location()?.pathname).toBe("/login");
    expect(r.win.entryCount).toBe(before + 1);
    r.router.dispose();
  });

  it("[RTR-R2-11] the object form honors replace the same way", async () => {
    const r = rig(routes(() => redirect({ to: "/login", replace: true })));
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/private");
    expect(r.win.entryCount).toBe(before);
    r.router.dispose();
  });

  it("[RTR-R2-11] without replace the navigation keeps its own mode, and the signal reports true", async () => {
    expect(redirect("/login").replace).toBe(true);
    expect(redirect("/login").replaceGiven).toBe(false);
    const r = rig(routes(() => redirect("/login")));
    await r.router.ready();
    const before = r.win.entryCount;
    await r.router.navigate("/private");
    expect(r.win.entryCount).toBe(before + 1);
    await r.router.navigate("/private", { replace: true });
    expect(r.win.entryCount).toBe(before + 1);
    r.router.dispose();
  });
});

describe("buildPath: dot segments", () => {
  it("[RTR-R2-12] a param value of . or .. throws a RangeError instead of a path the browser collapses", () => {
    expect(() => buildPath("/users/:id", { id: "." })).toThrow(RangeError);
    expect(() => buildPath("/users/:id", { id: ".." })).toThrow(RangeError);
    expect(() => buildPathFromParams("/users/:id/edit", { id: ".." })).toThrow(RangeError);
    expect(() => buildPathFromParams("/users/:id?", { id: "." })).toThrow(RangeError);
  });

  it("[RTR-R2-12] a piece of a splat value is checked too", () => {
    expect(() => buildPathFromParams("/files/*path", { path: "a/../b" })).toThrow(RangeError);
    expect(() => buildPathFromParams("/files/*path", { path: "./b" })).toThrow(RangeError);
  });

  it("[RTR-R2-12] values that only contain dots, or spell them with a percent, are plain text and stay", () => {
    expect(buildPath("/users/:id", { id: "..." })).toBe("/users/...");
    expect(buildPath("/users/:id", { id: "a.b" })).toBe("/users/a.b");
    expect(buildPath("/users/:id", { id: ".hidden" })).toBe("/users/.hidden");
    // The percent sign is escaped, so this is the text %2e, never a dot segment.
    expect(buildPath("/users/:id", { id: "%2e" })).toBe("/users/%252e");
  });
});
