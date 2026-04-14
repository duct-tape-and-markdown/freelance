/**
 * Test hook fixture: writes a plain object to context. Used by the
 * onEnter hook tests to verify local-script resolution, caching, and
 * arg-path resolution (the `from` arg is a `context.*` reference).
 */
export default async function ({ args }) {
  return { count: args.value ?? 0, echoed: args.from };
}
