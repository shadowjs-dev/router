import { afterEach, describe, expect, it } from "vitest";
import { type ScanResult, scanRoutes } from "../../src/vite/scan";
import { makeTree, PAGE, type TempTree } from "./support/tree";

/** Stream routes (`SSE` and `WS` exports): classified by the scanner, kept out of the route tree. */
const trees: TempTree[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) tree.dispose();
});

async function scan(files: Record<string, string>): Promise<ScanResult> {
  const tree = makeTree(files);
  trees.push(tree);
  return scanRoutes({ routesDir: tree.root });
}

const FEED = 'export function SSE(event, stream) { stream.send({ data: "hi" }); }\n';
const CHAT = "export const WS = { message(ws, data) { ws.send(data); } };\n";

describe("stream routes in the scanner", () => {
  it("[SRT-1] a file exporting SSE or WS is a stream route with the path of its file, not a page", async () => {
    const result = await scan({
      "live/feed.sse.ts": FEED,
      "chat/socket.ts": CHAT,
      "index.tsx": PAGE,
    });
    expect(result.streams.map((entry) => [entry.id, entry.kinds])).toEqual([
      ["/chat/socket", ["WS"]],
      ["/live/feed.sse", ["SSE"]],
    ]);
    expect(result.entries.map((entry) => entry.id)).toEqual(["/"]);
    expect(result.api).toEqual([]);
  });

  it("[SRT-2] a file exporting both SSE and WS is one stream route with both kinds", async () => {
    const result = await scan({ "room.ts": `${FEED}${CHAT}` });
    expect(result.streams.map((entry) => entry.kinds)).toEqual([["SSE", "WS"]]);
  });

  it("[SRT-3] a file that is a stream and also a page or an API route is a mixed-export error", async () => {
    const tree = makeTree({ "mixed.ts": `${FEED}export const GET = () => new Response("x");\n` });
    trees.push(tree);
    await expect(scanRoutes({ routesDir: tree.root })).rejects.toThrow(/stream route/);
  });

  it("[SRT-4] two stream files on one path, or a stream beside a page on the same path, are refused", async () => {
    const tree = makeTree({ "feed.ts": FEED, "feed/index.ts": FEED, "feed/page.tsx": PAGE });
    trees.push(tree);
    await expect(scanRoutes({ routesDir: tree.root })).rejects.toThrow(/feed/);
  });
});
