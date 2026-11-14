import type { MockFunctionOptions, TestContext } from 'node:test';

type MethodName<T> = { [K in keyof T]: T[K] extends Function ? K : never }[keyof T];
type MethodArguments<T> = T extends (...args: infer Args) => unknown ? Args : never;

export function mockMethod<T extends object, K extends MethodName<T>, R>(
  context: Pick<TestContext, 'mock'>,
  target: T,
  name: K,
  implementation: (this: T, ...args: MethodArguments<T[K]>) => R,
  options?: MockFunctionOptions,
) {
  return context.mock.method(target, name, implementation, options);
}
