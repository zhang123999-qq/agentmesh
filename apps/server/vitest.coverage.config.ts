import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Coverage-only config. Never picked up by a plain `vitest run`.
 *
 * Seven server integration suites import the built package
 * (`@agentmesh/server` -> `dist`) to test the real published entrypoint.
 * v8 cannot reliably attribute that execution back to `src` through source
 * maps, which would make `apps/server/src` look far less covered than it is.
 * Resolving the specifier to `src/index.ts` for the coverage run keeps the
 * measurement honest. Normal `npm test` still runs against `dist`, so the
 * CI build-order checks are unchanged.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@agentmesh/server': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
