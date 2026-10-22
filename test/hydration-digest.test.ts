import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, defineRoute, type RenderedMatch } from "../src/index";
import { everyFeature } from "./support/features";

/** The error of a failed loader, as the route's error UI reads it (`loaderData` is a failure with `error`). */
function failedErrorOf(match: RenderedMatch | undefined): Error | undefined {
  const data = match?.loaderData;
  if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
  const error = data.error;
  return error instanceof Error ? error : undefined;
}

describe("hydration of a failed loader keeps the error's digest", () => {
  it("[DIG-H1] the dehydrated failure carries the digest of the error, and its message", async () => {
    const boom = defineRoute("/boom", {
      id: "boom",
      loader: () => {
        throw Object.assign(new Error("db down"), { digest: "0123456789abcdef" });
      },
    });
    const server = createRouter({
      features: everyFeature(),
      routes: [boom],
      history: createMemoryHistory({ initialEntries: ["/boom"] }),
      onError: () => undefined,
    });
    await server.ready();
    const payload = server.dehydrate();
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]?.failed).toBe(true);
    expect(payload.matches[0]?.value).toEqual({
      name: "Error",
      message: "db down",
      digest: "0123456789abcdef",
    });
    server.dispose();
  });

  it("[DIG-H2] a hydrated failure has the digest back, so the error UI on the client shows the server's code", async () => {
    const boom = defineRoute("/boom", { id: "boom", loader: () => "unused" });
    const client = createRouter({
      features: everyFeature(),
      routes: [boom],
      history: createMemoryHistory({ initialEntries: ["/boom"] }),
      onError: () => undefined,
    });
    client.hydrate({
      version: 1,
      matches: [
        {
          id: "boom",
          params: {},
          deps: undefined,
          updatedAt: Date.now(),
          value: { name: "Error", message: "Internal Server Error", digest: "0123456789abcdef" },
          failed: true,
        },
      ],
    });
    await client.ready();
    const error = failedErrorOf(client.state.matches()[0]);
    expect(error?.message).toBe("Internal Server Error");
    expect((error as Error & { digest?: string }).digest).toBe("0123456789abcdef");
    client.dispose();
  });

  it("[DIG-H3] a failure without a digest hydrates as before: a message and no digest", async () => {
    const boom = defineRoute("/boom", { id: "boom", loader: () => "unused" });
    const client = createRouter({
      features: everyFeature(),
      routes: [boom],
      history: createMemoryHistory({ initialEntries: ["/boom"] }),
      onError: () => undefined,
    });
    client.hydrate({
      version: 1,
      matches: [
        {
          id: "boom",
          params: {},
          deps: undefined,
          updatedAt: Date.now(),
          value: { name: "Error", message: "plain" },
          failed: true,
        },
      ],
    });
    await client.ready();
    const error = failedErrorOf(client.state.matches()[0]);
    expect(error?.message).toBe("plain");
    expect("digest" in (error ?? {})).toBe(false);
    client.dispose();
  });
});
