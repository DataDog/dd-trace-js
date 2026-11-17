'use strict'

module.exports = {
  testDir: __dirname,
  testMatch: 'serial.js',
  workers: 1,
  retries: process.env.EXCLUSION_NATIVE === 'project' ? 2 : 0,
  reporter: 'line',
}
