'use strict'

const mode = process.env.PLAYWRIGHT_GLOBAL_ERROR_MODE

module.exports = {
  testDir: '.',
  testMatch: '*-test.js',
  workers: 1,
  retries: 0,
  reporter: 'line',
  projects: [{ name: 'chromium' }],
  outputDir: `./test-results-${mode}`,
  globalSetup: mode === 'global-setup' ? './hook.js' : undefined,
  globalTeardown: mode === 'global-teardown' ? './hook.js' : undefined,
  webServer: mode === 'web-server'
    ? { command: 'node server.js', cwd: __dirname, port: 1, timeout: 10000 }
    : undefined,
}
