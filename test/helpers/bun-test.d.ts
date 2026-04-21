/**
 * Minimal ambient declaration for `bun:test`. Keeps us off the full
 * `@types/bun` dep — we only use a couple of APIs and the runtime itself
 * provides the real implementation.
 */
declare module "bun:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;

  interface Matchers<T = unknown> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeInstanceOf(ctor: new (...args: never[]) => unknown): void;
    toMatch(pattern: RegExp | string): void;
    toHaveLength(n: number): void;
    not: Matchers<T>;
    rejects: Matchers<T>;
    resolves: Matchers<T>;
  }

  interface Expect {
    <T>(actual: T): Matchers<T>;
  }

  export const expect: Expect;
}
