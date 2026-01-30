'use strict'

module.exports = {
  reporter: [
    'text',
    'lcov'
  ],
  exclude: [
    '**/test/**/fixtures/**',
    '**/test/**/resources/**',
    '**/integration-tests/**/fixtures/**',
    '**/.bun/**',
    '**/vendor/**'
  ],
  // Avoid collisions when a single CI job runs coverage sequentially across multiple Node.js versions.
  tempDir: `.nyc_output-node-${process.version}`,
  reportDir: `coverage-node-${process.version}`,
  all: true,
  'check-coverage': true,
  // Baseline coverage
  lines: 60,
  statements: 60,
  functions: 60,
  branches: 60,
}
