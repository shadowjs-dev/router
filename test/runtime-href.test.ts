import { describe, expect, it } from "vitest";
import { unsafeHref } from "../src/index";

describe("unsafeHref: a run-time path that the typed navigation accepts", () => {
  it("[RH-01] a relative path and a root path (with a query and a fragment) are returned unchanged", () => {
    expect(unsafeHref("/sign-in?redirect_url=%2Fdashboard#top")).toBe(
      "/sign-in?redirect_url=%2Fdashboard#top",
    );
    expect(unsafeHref("dashboard/files")).toBe("dashboard/files");
  });

  it("[RH-02] another origin, a script URL and a protocol-relative host are refused in development", () => {
    expect(() => unsafeHref("https://evil.example/x")).toThrow(TypeError);
    expect(() => unsafeHref("javascript:alert(1)")).toThrow(TypeError);
    expect(() => unsafeHref("//evil.example/x")).toThrow(TypeError);
    expect(() => unsafeHref("/\\evil.example/x")).toThrow(TypeError);
    expect(() => unsafeHref("java\tscript:alert(1)")).toThrow(TypeError);
  });

  it("[RH-03] the refusal names the value and says what to do", () => {
    expect(() => unsafeHref("https://evil.example/x")).toThrow(/not a same-origin path/);
  });
});
