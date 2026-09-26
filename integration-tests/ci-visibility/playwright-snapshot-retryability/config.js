'use strict'

module.exports = {
  testMatch: '*-test.js',
  workers: 1,
  updateSnapshots: process.env.PLAYWRIGHT_SNAPSHOT_CASE === 'missing-no-update' ? 'none' : 'missing',
}
