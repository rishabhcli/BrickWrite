import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 4173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
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
              // chunk and takes it past a megabyte on its own.
              name: 'hexclave',
              test: /node_modules\/(?:@hexclave|@stripe|@ai-sdk|@radix-ui|@hookform|ai|react-hook-form|rrweb|@rrweb)\//,
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
