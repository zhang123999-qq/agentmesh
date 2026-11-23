import { defineConfig } from '@playwright/test';

/**
 * Browser e2e for the admin console (US-021G), reused by the M9 runtime sign-off.
 *
 * Kept under `e2e/` (excluded from the app's tsconfig) so the Next build never
 * needs `@playwright/test` to be installed. Run with:
 *
 *   npm i -D @playwright/test -w @agentmesh/web && npx playwright install chromium
 *   BASE_URL=http://localhost:3000 \
 *   ADMIN_AGENT_ID=agt_... ADMIN_SECRET=... \
 *     npm run test:e2e -w @agentmesh/web
 *
 * e2e is intentionally NOT part of the root `verify` gate (needs a browser and a
 * live stack); CI runs it as a separate optional job.
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
