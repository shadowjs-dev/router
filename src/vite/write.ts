import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The attempts a rename gets on Windows before its error is rethrown.
 * @example
 * RENAME_ATTEMPTS; // 4: the first try and three retries
 * @since 1.0.0
 */
export const RENAME_ATTEMPTS = 4;

/**
 * The codes a Windows rename raises while another process (an editor, the TypeScript server) holds the target
 * open. They pass when the holder lets go, so a retry is worth it there and nowhere else.
 */
const SHARING_ERRORS: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Renames `from` over `to`, retrying a sharing error on Windows. Windows refuses to replace a file another
 * process has open for a moment, and a second attempt usually succeeds. The retry is immediate: a sleep would
 * stall the write without helping, and the attempts are bounded by {@link RENAME_ATTEMPTS}.
 *
 * @param rename The rename to run: `fs.promises.rename` in production, a fake in tests.
 * @param from The temporary file.
 * @param to The file to replace.
 * @param platform The platform the retry applies to. Default: this machine's.
 * @returns Resolves when the rename succeeded.
 * @throws The last error when every attempt failed, or the first error that is not a sharing error.
 * @example await renameWithRetry(rename, "a.ts.123.tmp", "a.ts");
 * @since 1.0.0
 */
export async function renameWithRetry(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
      const retry =
        platform === "win32" &&
        attempt < RENAME_ATTEMPTS &&
        typeof code === "string" &&
        SHARING_ERRORS.has(code);
      if (!retry) throw error;
    }
  }
}

/**
 * Writes `content` to `file` only when the bytes differ from what is there. The write is atomic
 * (a temporary file in the same folder, then a rename), so a watcher or a reader never sees half a
 * file, and an unchanged tree never touches the file's modification time.
 *
 * @param file Absolute path.
 * @param content New text.
 * @returns True when the file was written.
 * @throws The file system error when the file cannot be read (other than missing) or written.
 * @example
 * await writeIfChanged("/app/src/routeTree.gen.ts", generateRouteTree(scan, { generatedFile }));
 * @since 1.0.0
 */
export async function writeIfChanged(file: string, content: string): Promise<boolean> {
  let current: string | undefined;
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current === content) return false;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await renameWithRetry(rename, temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}
