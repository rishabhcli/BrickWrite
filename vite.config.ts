import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
              // The account layer is statically imported by the entry module, so
              // without its own group the whole Hexclave SDK — and the Stripe,
              // Radix, rrweb and ai-sdk trees it carries — lands in the entry
              // chunk and takes it past a megabyte on its own. Keep this group
              // intact: splitting the SDK's mutually dependent modules across
              // max-size subchunks breaks their ESM initialization order in
              // Rolldown and leaves the production root blank.
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
  },
})
