'use strict'

module.exports = {
  testDir: '.',
  testMatch: 'playwright.js',
  // Each failure restarts a worker; the independent tests can retry concurrently.
  fullyParallel: true,
  workers: 3,
  retries: Number(process.env.NATIVE_RETRIES) || 0,
}
