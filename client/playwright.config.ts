import { defineConfig, devices } from '@playwright/test';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:5173';

/*
 * Drives the real browser against a real server, for the one layer the Vitest
 * suite cannot reach: Monaco bound to a Y.Text. Monaco does not run in jsdom,
 * and a mock of the binding would only assert that the mock behaves as
 * written.
 *
 * The dev server is used rather than a preview of the build, because the tests
 * are about behaviour rather than bundling, and `vite dev` needs no build step
 * to have run first. The API must already be running — it needs MongoDB, which
 * is the caller's business.
 */
export default defineConfig({
  testDir: './e2e',
  // Two peers editing one document is inherently order-sensitive; running
  // files in parallel against one server would have them racing for the same
  // rate-limit window as well.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  /*
   * Well past what any of these tests need, because the slow case is not the
   * test — it is the auth rate limiter.
   *
   * Every spec creates accounts, the limiter is per-address at 20 per minute,
   * and CI runs the smoke suite (which creates a dozen) immediately before
   * this one. The helper honours Retry-After, but that means a first signup can
   * legitimately sit out most of a minute, which blew straight through the 30s
   * default and produced exactly one flaky failure.
   */
  timeout: 120_000,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: APP_URL,
    // Only kept for a failure: a passing run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run dev',
    url: APP_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      VITE_API_URL: API_URL,
      VITE_WS_URL: `${API_URL.replace(/^http/, 'ws')}/yjs`,
    },
  },
});
