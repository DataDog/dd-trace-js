'use strict'

module.exports = {
  testDir: __dirname,
  testMatch: 'exclusions.js',
  workers: 2,
  fullyParallel: true,
  retries: process.env.EXCLUSION_NATIVE === '1' ? 2 : 0,
  reporter: 'line',
}
