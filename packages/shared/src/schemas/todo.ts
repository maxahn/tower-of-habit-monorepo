/**
 * TODO(2.1): delete this file once every stub that uses it is implemented.
 *
 * A placeholder that carries the final static type, so consumers and the
 * type-level tests compile today, but throws the moment anything touches it at
 * runtime. A loud failure beats a stub schema that quietly rejects everything:
 * that would turn every "rejects X" test green for the wrong reason.
 *
 * Internal: not re-exported from the schemas barrel.
 */
export function notImplemented<T>(name: string): T {
  const fail = (): never => {
    throw new Error(`TODO(2.1): ${name} is not implemented yet`);
  };
  return new Proxy(
    {},
    {
      get(_target, key) {
        // Let promise detection and test-runner introspection pass through, so
        // the failure surfaces at the real call site rather than inside vitest.
        if (key === 'then') return undefined;
        if (typeof key === 'symbol' && key !== Symbol.iterator) return undefined;
        return fail();
      },
      has: fail,
      ownKeys: fail,
    }
  ) as T;
}
