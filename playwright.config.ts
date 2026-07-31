import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

const runDirectory = process.env.JOURNEY_UNFINISHED_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-e2e-'))
process.env.JOURNEY_UNFINISHED_E2E_DIR = runDirectory

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:3200',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npx nuxt dev --host 127.0.0.1 --port 3200',
    url: 'http://127.0.0.1:3200/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NUXT_DATABASE_PATH: path.join(runDirectory, 'app.sqlite'),
      NUXT_UPLOAD_DIR: path.join(runDirectory, 'uploads'),
      NUXT_PUBLIC_APP_URL: 'http://127.0.0.1:3200',
      NUXT_DISCORD_CLIENT_ID: 'test-client',
      NUXT_DISCORD_CLIENT_SECRET: 'test-secret',
      NUXT_ADMIN_DISCORD_IDS: '123456789012345678'
    }
  }
})
