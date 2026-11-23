import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Web unit + integration tests (US-021G).
 *
 * Node environment: we test pure lib logic (seq registry, error mapping) and
 * the real SDK driven by a mock transport — no DOM needed. Browser e2e lives in
 * `e2e/` (Playwright) and is run separately (`npm run test:e2e`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
