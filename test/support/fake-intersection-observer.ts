/**
 * A controllable `IntersectionObserver` for DOM tests. Tests call `report` to say an element
 * entered or left the viewport; the observer delivers that to its callback, just as the browser
 * would after a layout pass.
 */
export class FakeIntersectionObserver {
  /** Every observer constructed since the last `reset`, in creation order. */
  static readonly instances: FakeIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  readonly #targets = new Set<Element>();
  readonly #callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.#callback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
    FakeIntersectionObserver.instances.push(this);
  }

  /** Elements this observer currently watches. */
  get targets(): readonly Element[] {
    return [...this.#targets];
  }

  observe(target: Element): void {
    this.#targets.add(target);
  }

  unobserve(target: Element): void {
    this.#targets.delete(target);
  }

  disconnect(): void {
    this.#targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Reports that `target` entered (`true`) or left (`false`) the viewport. Ignored if unwatched. */
  report(target: Element, isIntersecting: boolean): void {
    if (!this.#targets.has(target)) return;
    const entry = {
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      time: 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
    } as unknown as IntersectionObserverEntry;
    this.#callback([entry], this as unknown as IntersectionObserver);
  }

  /** Clears the recorded instances so the next test starts from none. */
  static reset(): void {
    FakeIntersectionObserver.instances.length = 0;
  }
}
