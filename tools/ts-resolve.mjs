/**
 * Lets Node run the server sources in place while they name imports the way
 * the deployed build needs them named.
 *
 * `server/` is consumed by two things that disagree. Vercel transpiles each
 * file to `.js` and copies specifiers through untouched, so a relative import
 * has to say `./x.js` or it throws ERR_MODULE_NOT_FOUND in production. Node's
 * type stripping runs the `.ts` file itself and resolves specifiers against
 * real files on disk, and it deliberately does not map `./x.js` back to
 * `./x.ts`. Vite and vitest do map it, which is why only `node server/index.ts`
 * ever noticed.
 *
 * So: when a relative `./x.js` has no `.js` on disk but does have a sibling
 * `.ts`, resolve to the `.ts`. Anything else falls straight through, including
 * a real `.js` sitting next to a `.ts` of the same name.
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = `${specifier.slice(0, -3)}.ts`
      if (!existsSync(new URL(specifier, context.parentURL)) && existsSync(new URL(asTs, context.parentURL))) {
        return next(asTs, context)
      }
    }
    return next(specifier, context)
  },
})
