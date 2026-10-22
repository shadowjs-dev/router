import { describe, expect, it } from "vitest";
import { SearchValidationError } from "../src/core/index";
import { defineRoute } from "../src/index";
import { rig } from "./support/rig";

/** A Standard Schema (v1) object that accepts `page` as a whole number, the way Zod or Valibot would. */
function pageSchema() {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate(value: unknown) {
        const raw =
          typeof value === "object" && value !== null ? Reflect.get(value, "page") : undefined;
        // The codec decodes `3` to the number 3 (see G-C1); `abc` stays a string.
        const page =
          typeof raw === "number" && Number.isInteger(raw)
            ? raw
            : typeof raw === "string" && /^\d+$/.test(raw)
              ? Number(raw)
              : undefined;
        if (page !== undefined) return { value: { page } };
        return { issues: [{ message: "page must be a whole number", path: ["page"] }] };
      },
    },
  };
}

describe("validateSearch with a Standard Schema (G-C2)", () => {
  it("[G-C2] a schema that accepts the query hands its output to the loader", async () => {
    const seen: unknown[] = [];
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/list", {
        validateSearch: pageSchema(),
        loader: ({ search }) => {
          seen.push(search);
          return search;
        },
      }),
    ]);
    await r.router.ready();
    const outcome = await r.router.navigate("/list?page=3");
    expect(outcome.kind).toBe("success");
    expect(seen).toEqual([{ page: 3 }]);
    r.router.dispose();
  });

  it("[G-C2] a schema issue fails the navigation with a SearchValidationError that names the failing key", async () => {
    const r = rig([defineRoute("/", {}), defineRoute("/list", { validateSearch: pageSchema() })]);
    await r.router.ready();
    const outcome = await r.router.navigate("/list?page=abc");
    expect(outcome.kind).toBe("error");
    const error = outcome.kind === "error" ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SearchValidationError);
    expect(error instanceof SearchValidationError ? error.issues : []).toEqual([
      { message: "page must be a whole number", path: ["page"] },
    ]);
    r.router.dispose();
  });

  it("[G-C2] a plain function that throws a SearchValidationError fails the same way", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/list", {
        validateSearch: (search) => {
          if (search["page"] !== undefined && search["page"] !== "1") {
            throw new SearchValidationError([{ message: "only page 1", path: ["page"] }]);
          }
          return { page: 1 };
        },
      }),
    ]);
    await r.router.ready();
    const outcome = await r.router.navigate("/list?page=2");
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.error instanceof SearchValidationError).toBe(true);
    r.router.dispose();
  });

  it("[G-C2] a plain Error from a function is still an ordinary error, not a validation error", async () => {
    const r = rig([
      defineRoute("/", {}),
      defineRoute("/list", {
        validateSearch: () => {
          throw new Error("bug");
        },
      }),
    ]);
    await r.router.ready();
    const outcome = await r.router.navigate("/list?page=2");
    expect(outcome.kind === "error" && outcome.error instanceof SearchValidationError).toBe(false);
    r.router.dispose();
  });

  it("[G-C2] a schema whose validate returns a Promise is refused: search validation is synchronous", async () => {
    const asyncSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: async (value: unknown) => ({ value }),
      },
    };
    const r = rig([defineRoute("/", {}), defineRoute("/list", { validateSearch: asyncSchema })]);
    await r.router.ready();
    const outcome = await r.router.navigate("/list?page=2");
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.error instanceof TypeError).toBe(true);
    r.router.dispose();
  });
});
