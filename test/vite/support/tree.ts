import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Writes a map of relative paths to file contents into a fresh temp directory, so scanner tests
 * run against a real file system. `dispose` removes the directory.
 */
export interface TempTree {
  readonly root: string;
  dispose(): void;
}

/** A page module with a default export. */
export const PAGE = "export default function Page() { return null; }\n";

export function makeTree(files: Record<string, string>): TempTree {
  const root = mkdtempSync(join(tmpdir(), "shadow-routes-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
