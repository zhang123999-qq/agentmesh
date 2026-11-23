import { expect, test } from '@playwright/test';

/**
 * Admin-console browser smoke (US-021G), reused by M9.
 *
 * - The first test only needs the web app served (no backend): it proves the
 *   Playwright harness and the page render.
 * - The live-flow tests need a reachable AgentMesh server + an admin account and
 *   are skipped unless ADMIN_AGENT_ID / ADMIN_SECRET are provided. Point
 *   BASE_URL at the app (local `next start` or the Caddy origin in compose).
 *
 * The full task lifecycle (award → progress → complete → review approve → done)
 * is exercised deterministically by `npm run demo`; here we cover the browser
 * path most likely to regress: login → channel → send → visible message.
 */

test('login page renders the admin form', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'AgentMesh Admin' })).toBeVisible();
  await expect(page.getByLabel('Agent ID')).toBeVisible();
  await expect(page.getByLabel('Secret')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
});

const adminId = process.env.ADMIN_AGENT_ID;
const adminSecret = process.env.ADMIN_SECRET;

test.describe('live stack flow', () => {
  test.skip(
    adminId === undefined || adminSecret === undefined,
    'set ADMIN_AGENT_ID and ADMIN_SECRET (and a reachable backend) to run',
  );

  test('login → channel → send message → message is visible', async ({ page }) => {
    page.on('console', (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) =>
      console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`),
    );
    page.on('websocket', (ws) => {
      console.log(`[ws] ${ws.url()}`);
      ws.on('socketerror', (e) => console.log(`[ws error] ${e}`));
      ws.on('close', () => console.log('[ws closed]'));
    });

    await page.goto('/login');
    await page.getByLabel('Agent ID').fill(adminId as string);
    await page.getByLabel('Secret').fill(adminSecret as string);
    await page.getByRole('button', { name: '登录' }).click();

    // Surface the page's error toast before asserting the redirect.
    await page.waitForTimeout(1500);
    if (!page.url().includes('/dashboard')) {
      console.log('[page body]', (await page.locator('body').innerText()).slice(0, 400));
    }

    // Redirect to the dashboard after a successful admin login.
    await expect(page).toHaveURL(/\/dashboard/);

    // Go to the channels view.
    await page.goto('/dashboard/channels');

    // Create a throwaway channel and open it.
    const channelName = `e2e-${Date.now()}`;
    await page.getByPlaceholder('新频道名称').fill(channelName);
    await page.getByRole('button', { name: '创建频道' }).click();
    await page.getByRole('button', { name: new RegExp(channelName) }).click();

    // Send a message and confirm it renders (history + live share one seq key).
    const body = `hello-${Date.now()}`;
    await page.getByPlaceholder('输入消息...').fill(body);
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByText(body)).toBeVisible();
  });
});
