/**
 * Answer zod's `eval` probe before zod is loaded.
 *
 * zod feature-detects its JIT compiler by calling `new Function` once and
 * catching the failure. Under a Content-Security-Policy the attempt is
 * reported even though the throw is swallowed and nothing breaks — zod's own
 * source says so beside `allowsEval`. The compiler is opt-in through
 * `zod/compile` and this app never opts in, so answering in advance turns off
 * a fast path that was never running.
 *
 * Two things make this awkward, and both are why the setting lives here rather
 * than as a `config({ jitless: true })` call in a route:
 *
 * Order. `allowsEval` is read while an object schema is set up, so the answer
 * has to be in place before the first schema module is evaluated. ES imports
 * are hoisted, so a call in a route's body already runs too late — every
 * schema that route imports has been built by then.
 *
 * Weight. Importing `config` from `zod`, or even from `zod/v4/core`, brings
 * the schema builders with it. Doing that from the entry — the only place
 * early enough — put 24 KiB gzipped of zod in front of the landing page.
 *
 * So this seeds the object zod itself lazily creates:
 *
 *   globalThis.__zod_globalConfig ?? (globalThis.__zod_globalConfig = {})
 *
 * zod keeps whatever is already there, which makes seeding it first both
 * early enough and free. It is an internal name, so `zod-jitless.test.ts`
 * loads zod for real and asserts it honours this — if the name ever changes,
 * that test fails rather than the violation quietly coming back.
 */
declare global {
  var __zod_globalConfig: { jitless?: boolean } | undefined
}

const zodConfig = (globalThis.__zod_globalConfig ??= {})
zodConfig.jitless = true

export {}
