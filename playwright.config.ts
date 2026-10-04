import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'test-results/e2e.xml' }]] : 'list',
  outputDir: 'test-results',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
