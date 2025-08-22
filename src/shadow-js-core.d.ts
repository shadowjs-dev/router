// Type declarations for @shadow-js/core peer dependency
// This file provides type stubs when the actual package is not available

declare module "@shadow-js/core" {
  // Reactive primitives
  export function useStore<T>(initialValue: T): StoreTuple<T>;

  // Lifecycle hooks
  export function useEffect(callback: () => void | (() => void)): void;
  export function useMemo<T>(callback: () => T, deps?: any[]): T;
  export function onMount(callback: () => void): void;

  // JSX runtime
  export function jsx(component: any, props: any, key?: string | number): any;

  // Store type - matches ShadowJS reactive store pattern
  // This supports both callable stores and array destructuring
  export interface Store<T> {
    (): T;
    set?: (value: T) => void | ((name: string, value: string) => void);
    [key: string]: any; // Allow additional properties and methods
  }

  // Array-like store for destructuring [value, setter]
  export type StoreTuple<T> = [Store<T>, (value: T) => void];

  // Export everything as default for compatibility
  export default {
    useStore,
    useEffect,
    useMemo,
    onMount,
    jsx,
  };
}
