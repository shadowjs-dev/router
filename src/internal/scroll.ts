import { decodeHash, type HistoryAction } from "../core/index";
import type { RouterWindow } from "../types";
import { type FragmentTarget, focusFragmentTarget } from "./fragment";

/**
 * Scroll restoration keyed by history entry index.
 *
 * PUSH scrolls to the top, or to the hash target; POP restores the position saved for the entry it lands
 * on, once the new content has rendered; REPLACE keeps the position. Every landing runs after the commit has
 * rendered (the router calls {@link ScrollRestoration.afterCommit} after the flush), so a hash target that the new
 * page renders is found. A target that mounts later (a lazy view, a Suspense boundary) is looked for on the
 * following frames, for a bounded number of them; a page change whose target never appears then starts at the top.
 * A pending landing is dropped as soon as the user scrolls by hand, so a late one never fights the user.
 *
 * Positions also go to `sessionStorage` (when the window has it) so a reload keeps them. Storage
 * failures (disabled, full, blocked) are reported as dev warnings and the router keeps working in
 * memory.
 */

/** Entries kept. Forward entries are dropped on every push, so this bounds the live history. */
const MAX_SAVED = 500;

interface Position {
  readonly x: number;
  readonly y: number;
}

/** Scroll bookkeeping of one router. */
export interface ScrollRestoration {
  /** Records the current scroll position for an entry index. */
  remember(index: number): void;
  /** Applies the scroll that a committed change calls for. It runs after the new content has rendered. */
  afterCommit(action: HistoryAction, index: number, hash: string): void;
  /** Removes every listener. */
  dispose(): void;
}

/** Options of {@link createScrollRestoration}. */
export interface ScrollOptions {
  readonly window: RouterWindow;
  /** The index of the entry the page shows now. */
  readonly currentIndex: () => number;
  /** Key under which positions are kept in session storage. */
  readonly storageKey: string;
  /** Runs once the new content has rendered (a microtask in the browser). */
  readonly schedule: (run: () => void) => void;
  /** Runs on a later frame: a page that loads its view after the commit is not tall yet. */
  readonly nextFrame: (run: () => void) => void;
  /** Moves focus to a hash target after the page change scrolled to it (see {@link focusFragmentTarget}). */
  readonly focus: (target: FragmentTarget) => void;
  /** The page on screen, as path and query (a trailing slash or the hash alone make no other page). */
  readonly pageOf: () => string;
}

/**
 * Frames a landing keeps trying for. A route's view can mount after the commit (its module may load first),
 * so the page is not tall enough, or the target not there, at the first attempt; about a second covers that.
 */
const RESTORE_FRAMES = 60;

function isPosition(value: unknown): value is readonly [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

function reportStorage(action: string, error: unknown): void {
  if (__DEV__) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[shadow ROUTER_SCROLL_STORAGE] ${action} failed: ${detail}`);
  }
}

/** Reads saved positions. Malformed or unreadable storage gives an empty map. */
function loadSaved(win: RouterWindow, key: string): Map<number, Position> {
  const saved = new Map<number, Position>();
  try {
    const raw = win.sessionStorage?.getItem(key);
    if (raw === null || raw === undefined) return saved;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return saved;
    for (const item of parsed) {
      if (isPosition(item) && saved.size < MAX_SAVED) {
        saved.set(item[0], { x: item[1], y: item[2] });
      }
    }
  } catch (error) {
    reportStorage("read", error);
  }
  return saved;
}

/**
 * Creates the scroll controller of one router. Adds `pagehide`, `wheel` and `touchstart` listeners
 * to the window until {@link ScrollRestoration.dispose}.
 *
 * @example
 * const scroll = createScrollRestoration({ window, currentIndex: () => 0, storageKey: "k", schedule: queueMicrotask, nextFrame: run => requestAnimationFrame(run), focus: focusFragmentTarget, pageOf: () => location.pathname });
 */
export function createScrollRestoration(options: ScrollOptions): ScrollRestoration {
  const win = options.window;
  const saved = loadSaved(win, options.storageKey);
  /** The landing in progress: a token that a user scroll or the next commit replaces (cancels). */
  let landing: object | undefined;
  /** The page of the last commit, to tell a change of page from a change of hash. */
  let page: string | undefined;

  const persist = (): void => {
    try {
      const rows = Array.from(saved, ([index, position]) => [index, position.x, position.y]);
      win.sessionStorage?.setItem(options.storageKey, JSON.stringify(rows));
    } catch (error) {
      reportStorage("write", error);
    }
  };

  const remember = (index: number): void => {
    saved.set(index, { x: win.scrollX ?? 0, y: win.scrollY ?? 0 });
    if (saved.size > MAX_SAVED) {
      let oldest: number | undefined;
      for (const key of saved.keys()) {
        if (oldest === undefined || key < oldest) oldest = key;
      }
      if (oldest !== undefined) saved.delete(oldest);
    }
    persist();
  };

  /**
   * Runs `attempt` first (through `first`, which is how the caller schedules it), then on each later frame, until it
   * reports done. After {@link RESTORE_FRAMES} frames `giveUp` runs. A user scroll or the next commit cancels it.
   */
  const landOn = (
    attempt: () => boolean,
    giveUp: () => void,
    first: (run: () => void) => void,
  ): void => {
    const token = {};
    landing = token;
    let frames = 0;
    const step = (): void => {
      if (landing !== token) return;
      if (attempt()) {
        landing = undefined;
        return;
      }
      frames += 1;
      if (frames >= RESTORE_FRAMES) {
        landing = undefined;
        giveUp();
        return;
      }
      options.nextFrame(step);
    };
    first(step);
  };

  /**
   * Scrolls the element a hash names into view, and gives it focus when the page changed. False when the page has no
   * such element yet.
   */
  const scrollToHash = (hash: string, pageChanged: boolean): boolean => {
    const target = win.document?.getElementById?.(decodeHash(hash));
    if (target === undefined || target === null) return false;
    target.scrollIntoView?.();
    if (pageChanged) options.focus(target);
    return true;
  };

  const onUserScroll = (): void => {
    landing = undefined;
  };
  const onPageHide = (): void => {
    remember(options.currentIndex());
  };
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("wheel", onUserScroll);
  win.addEventListener("touchstart", onUserScroll);
  // The browser's own restoration would scroll the entry it lands on, possibly before the new view
  // exists, and fight this controller. The controller takes over and gives the setting back on dispose.
  const history = win.history as RouterWindow["history"] | undefined;
  const previousRestoration = history?.scrollRestoration;
  if (history !== undefined) history.scrollRestoration = "manual";

  return {
    remember,

    afterCommit(action: HistoryAction, index: number, hash: string): void {
      landing = undefined;
      const current = options.pageOf();
      const pageChanged = current !== page;
      page = current;
      if (action === "REPLACE") return;
      if (action === "PUSH") {
        // The new entry takes `index`, so any position still saved there belongs to an entry the push
        // has just replaced: it goes too.
        let dropped = false;
        for (const key of [...saved.keys()]) {
          if (key >= index) {
            saved.delete(key);
            dropped = true;
          }
        }
        if (dropped) persist();
        if (hash === "") {
          win.scrollTo?.(0, 0);
          return;
        }
        if (!pageChanged) {
          // The same page: the target is on it already, so one attempt, and no top scroll when it is missing.
          scrollToHash(hash, false);
          return;
        }
        // A new page: its target may mount after the commit. The first attempt is right now, the rest on frames.
        landOn(
          () => scrollToHash(hash, true),
          () => win.scrollTo?.(0, 0),
          (run) => run(),
        );
        return;
      }
      const position = saved.get(index);
      if (position === undefined) return;
      // Scrolls to the saved position until the page is tall enough, then stops. A scroll by the user (see
      // onUserScroll) or another navigation cancels the restore.
      landOn(
        () => {
          win.scrollTo?.(position.x, position.y);
          return (win.scrollY ?? 0) === position.y;
        },
        () => undefined,
        options.schedule,
      );
    },

    dispose(): void {
      win.removeEventListener("pagehide", onPageHide);
      win.removeEventListener("wheel", onUserScroll);
      win.removeEventListener("touchstart", onUserScroll);
      landing = undefined;
      if (history !== undefined && previousRestoration !== undefined) {
        history.scrollRestoration = previousRestoration;
      }
    },
  };
}
