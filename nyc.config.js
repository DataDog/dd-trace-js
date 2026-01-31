'use strict'

module.exports = {
  reporter: [
    'text',
    'lcov'
  ],
  exclude: [
    '**/test/**',
    '**/integration-tests/**',
    '**/.bun/**',
    '**/vendor/**',
    '**/*.spec.*',
  ],
  // Avoid collisions when a single CI job runs coverage sequentially across multiple Node.js versions.
  tempDir: `.nyc_output-node-${process.version}`,
  reportDir: `coverage-node-${process.version}`,
  all: true,
  // Baseline coverage is disabled because some of our CI suites only run
  // coverage on a small subset of the codebase. The only value we may trust is
  // the combined coverage of all suites.
  'check-coverage': false
}
