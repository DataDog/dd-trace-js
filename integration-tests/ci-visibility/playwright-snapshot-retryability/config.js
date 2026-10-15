'use strict'

module.exports = {
  testMatch: '*-test.js',
  workers: 1,
  // Explicit "missing" accepts new baselines in Playwright 1.64; the default preserves the non-retriable failure.
  updateSnapshots: process.env.PLAYWRIGHT_SNAPSHOT_CASE === 'missing-no-update' ? 'none' : undefined,
}
