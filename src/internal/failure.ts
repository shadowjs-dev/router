/**
 * A loader that threw, carried as its data.
 *
 * The navigator commits only successful navigations, so a loader error is returned as this marker
 * instead of being thrown. The location then commits, the route's error boundary renders the marker's
 * error, and nothing thrown is logged as unexpected. Redirects and not-found signals are never
 * wrapped; they keep their control-flow meaning.
 */
export class LoaderFailure {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }
}

/**
 * An own data property of a thrown value, read through its descriptor: no getter runs, since a getter is application
 * code that may throw in the middle of the error path. An `Error` carries its `message` and `digest` as own properties.
 */
export function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  // An accessor descriptor has no `value`, so an accessor reads as undefined without running its getter.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * Shallow message of a thrown value, for hydration data. A primitive is shown as text; an object shows its string
 * `message` data property, or a fixed phrase. An object is never converted with `toString` (a null-prototype object
 * has none, and a user `toString` may throw).
 */
export function messageOf(value: unknown): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return String(value);
  const message = ownData(value, "message");
  return typeof message === "string" ? message : "Unexpected error";
}

/**
 * The `digest` an error carries (the code its error UI shows), or undefined. Only a string is kept: the digest goes
 * into the JSON the page is served with, and a cyclic, BigInt or object digest would make that serialization throw.
 */
export function digestOf(value: unknown): string | undefined {
  const digest = ownData(value, "digest");
  return typeof digest === "string" ? digest : undefined;
}

/** What a failed load is dehydrated to: its message and its digest. Never its stack. */
export function failureValueOf(error: unknown): {
  name: string;
  message: string;
  digest: string | undefined;
} {
  return { name: "Error", message: messageOf(error), digest: digestOf(error) };
}

/**
 * The error a hydrated failure stands for: its message, and its `digest` when the server gave the error one (the
 * digest is what the error UI shows, so the client's copy shows the same code).
 */
export function failureOf(value: unknown): Error {
  const error = new Error(messageOf(value));
  const digest = digestOf(value);
  return digest === undefined ? error : Object.assign(error, { digest });
}
