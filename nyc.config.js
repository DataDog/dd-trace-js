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
  // TODO: enable this once we have more coverage
  // all: true,
  'check-coverage': true,
  // Baseline coverage
  // TODO: increase these once we have more coverage
  lines: 40,
  statements: 40,
  functions: 40,
  branches: 40,
}
