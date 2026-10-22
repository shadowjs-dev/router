import { describe, expect, it } from "vitest";
import { RENAME_ATTEMPTS, renameWithRetry } from "../../src/vite/write";

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  error.code = code;
  return error;
}

/**
 * A rename that fails with the code `fail` names for an attempt (1-based), and succeeds when it names none.
 * It counts the attempts, so a test can assert the bound.
 */
function fakeRename(fail: (attempt: number) => string | undefined): {
  rename: (from: string, to: string) => Promise<void>;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    rename: async (): Promise<void> => {
      attempts += 1;
      const code = fail(attempts);
      if (code !== undefined) throw errorWithCode(code);
    },
    attempts: () => attempts,
  };
}

describe("atomic write on Windows", () => {
  it("[RTR-W-01] a rename that fails twice with a sharing error then succeeds is retried until it works", async () => {
    const fake = fakeRename((attempt) => (attempt <= 2 ? "EPERM" : undefined));
    await expect(renameWithRetry(fake.rename, "a.tmp", "a.ts", "win32")).resolves.toBeUndefined();
    expect(fake.attempts()).toBe(3);
  });

  it("[RTR-W-02] a rename that always fails is retried at most four times, then its error is rethrown", async () => {
    expect(RENAME_ATTEMPTS).toBe(4);
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      const fake = fakeRename(() => code);
      const outcome = await renameWithRetry(fake.rename, "a.tmp", "a.ts", "win32").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(outcome, code).toBeInstanceOf(Error);
      expect(Reflect.get(outcome as object, "code"), code).toBe(code);
      expect(fake.attempts(), code).toBe(4);
    }
  });

  it("[RTR-W-03] only the sharing errors are retried: any other code is rethrown at once", async () => {
    const missing = fakeRename(() => "ENOENT");
    await expect(renameWithRetry(missing.rename, "a.tmp", "a.ts", "win32")).rejects.toThrow(
      /ENOENT/,
    );
    expect(missing.attempts()).toBe(1);
  });

  it("[RTR-W-04] off Windows the first failure is rethrown: the retry is a Windows-only workaround", async () => {
    const fake = fakeRename((attempt) => (attempt === 1 ? "EPERM" : undefined));
    await expect(renameWithRetry(fake.rename, "a.tmp", "a.ts", "linux")).rejects.toThrow(/EPERM/);
    expect(fake.attempts()).toBe(1);
  });
});
