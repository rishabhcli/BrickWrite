import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Where Vite looks for `.env` files.
 *
 * Under test, nowhere. Several cloud tests assert the *unconfigured* path — the
 * honest local-only mode a visitor with no deployment gets — and they can only
 * do that if the harness has no deployment either. A developer's own
 * `.env.local` would otherwise decide whether they pass, so the tests most
 * likely to fail are the ones belonging to whoever is actually working on the
 * cloud path. It also keeps a real deployment URL and any other local secret out
 * of the module graph the suite runs against.
 *
 * `test.env` is not enough on its own: it reaches `process.env`, but
 * `import.meta.env` is assembled from the `.env` files at config time, and
 * `vi.stubEnv` does not reach it either — measured, not assumed. Only pointing
 * `envDir` at a directory that holds no env files actually clears it.
 */
const envDir = process.env.VITEST ? new URL('./src/test', import.meta.url).pathname : undefined

/*
 * Under test, no `VITE_*` variable from the surrounding shell reaches the app.
 *
 * `envDir` above stops `.env` *files* from deciding the suite's answers, and it
 * is not enough on its own: Vite also exposes any shell variable matching
 * `envPrefix`, so `VITE_CONVEX_URL=… npx vitest run src/cloud` still failed the
 * unconfigured-path tests — measured, after the `envDir` change was already in
 * place. Deleting them here works because this module runs before Vite resolves
 * the env it hands to `import.meta.env`.
 *
 * Nothing legitimate is lost. A test cannot rely on a `VITE_*` value in
 * `import.meta.env` anyway: `test.env` reaches only `process.env`, and
 * `vi.stubEnv` does not reach `import.meta.env` at all. Injection goes through a
 * constructor argument instead — `createConvexCloud({ url })` — which is how the
 * configured-path tests already do it.
 */
if (process.env.VITEST) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VITE_')) delete process.env[key]
  }
}

/**
 * Carry a WebMCP origin-trial token into the document, when one is configured.
 *
 * Three ways a browser can have WebMCP: the ChatGPT desktop app's in-app
 * browser has it on, Chrome has it behind
 * `chrome://flags/#enable-webmcp-testing`, and Chrome 149+ enables it for any
 * origin that presents a valid origin-trial token. Only the third is something
 * a deployment can decide, and it is worth deciding: it is what makes the tools
 * work for a visitor in stock Chrome who has never heard of a flag.
 *
 * Injected rather than written into `index.html` because a token is bound to
 * one origin and expires. A missing variable must emit no tag at all — an empty
 * `content` is a malformed token, and Chrome reports it on every load.
 */
function webmcpOriginTrial(): Plugin {
  const token = process.env.VITE_WEBMCP_ORIGIN_TRIAL?.trim()
  return {
    name: 'brickwright:webmcp-origin-trial',
    transformIndexHtml: () =>
      token
        ? [{ tag: 'meta', attrs: { 'http-equiv': 'origin-trial', content: token }, injectTo: 'head-prepend' as const }]
        : [],
  }
}

export default defineConfig({
  plugins: [react(), webmcpOriginTrial()],
  envDir,
  // The assistant and generation routes hold the model API key, so they run in
  // a separate Node process rather than in Vite's module graph. Proxying keeps
  // the browser talking to one origin in development. Production must provide
  // the same `/api` routing to the separately deployed Node service; the Pages
  // share functions do not implicitly host these model routes.
  server: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: process.env.BRICKWRIGHT_API_URL ?? 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: process.env.BRICKWRIGHT_API_URL ?? 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  build: {
    // Hexclave is intentionally one 1.9 MB (about 480 KB gzip) vendor chunk;
    // the explanation and runtime regression gate live beside its group below.
    chunkSizeWarningLimit: 2_000,
    // Keep the interactive CAD shell cacheable without allowing Three/R3F and
    // the kernel to collapse back into megabyte-scale monoliths.
    modulePreload: {
      resolveDependencies: (_filename, deps) => deps.filter((dep) => !/hexclave/i.test(dep)),
    },
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 30_000,
          maxSize: 450_000,
          groups: [
            {
              name: 'rendering',
              test: /node_modules\/(?:three|three-mesh-bvh|@react-three|three-stdlib|camera-controls|maath|meshline|troika-three-text|zustand)\//,
            },
            {
              name: 'react',
              test: /node_modules\/(?:react|react-dom|react-reconciler|scheduler|its-fine|use-sync-external-store)\//,
            },
            {
              // The account layer is dynamically imported after first paint.
              // Keep this group intact: splitting the SDK's mutually dependent
              // modules across max-size subchunks breaks their ESM
              // initialization order in Rolldown and leaves the production
              // root blank.
              name: 'hexclave',
              test: /node_modules\/(?:@hexclave|@stripe|@ai-sdk|@radix-ui|@hookform|ai|react-hook-form|rrweb|@rrweb)\//,
              maxSize: 10_000_000,
            },
            {
              name: 'contracts',
              test: /node_modules\/zod\//,
            },
            {
              name: 'ui',
              test: /node_modules\/lucide-react\//,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    /*
     * A worker cap, because the default one loses tests on a large machine.
     *
     * Several suites load the shipped 48 MB catalog per worker —
     * `manifest.test.ts` and the part-ranker's real-catalog fixture — so the
     * limit here is memory and import bandwidth, not cores. Measured on a
     * 14-core box: the default spawns enough workers to time out **10** tests
     * with `import` alone at 290 s; `maxWorkers=7` still loses 3; `4` passes all
     * 2,906 in 208 s, which is also *faster* than the `--maxWorkers=2` that had
     * been used as a workaround.
     *
     * A percentage rather than a literal, so it scales down to a two-core CI
     * runner instead of over-subscribing it. This lives in the config rather
     * than in the npm script so that `npx vitest run` — what anyone debugging a
     * single file actually types — gets the same pool as CI.
     */
    maxWorkers: '25%',
    /*
     * The default 5 s budget is a per-test budget spent mostly on other tests.
     * A suite that renders the shell imports React, the router and every
     * surface it touches while three other workers are doing the same, so the
     * wall clock a `render` + `findBy*` pair takes is set by import bandwidth
     * rather than by anything the test asserts: `shell.test.tsx` passes in
     * 6.5 s on its own and has timed out at 5 s inside the full run. Raising
     * the floor keeps a loaded machine from reporting a scheduling delay as a
     * failed assertion; a test that is genuinely hung still fails, 10 s later.
     */
    testTimeout: 15_000,
    // `process.env` only; `import.meta.env` is cleared by `envDir` above.
    env: {
      VITE_HEXCLAVE_PROJECT_ID: '',
      HEXCLAVE_PROJECT_ID: '',
    },
  },
})
