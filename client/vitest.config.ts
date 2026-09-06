import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/*
 * A separate file rather than a `test` block inside vite.config.ts.
 *
 * That config is the function form and carries the missing-VITE_API_URL build
 * guard. The guard is scoped to `command === 'build' && mode === 'production'`
 * so a test run cannot trip it, but it is load-bearing enough to be worth
 * leaving alone.
 *
 * Merging rather than redeclaring inherits the monaco-editor resolve alias,
 * without which anything transitively importing y-monaco fails to resolve.
 */
export default mergeConfig(
  viteConfig({ command: 'serve', mode: 'test' }),
  defineConfig({
    test: {
      // No DOM. These cover pure functions and Y.Text; Monaco cannot run in
      // jsdom, so the binding itself is covered by the Playwright suite
      // instead of a mock that would prove nothing.
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }),
);
