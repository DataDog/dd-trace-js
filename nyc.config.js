'use strict'

// Include the current npm script name (when available) so coverage artifacts are attributable.
const event = process.env.npm_lifecycle_event ?? ''
// Script names may include characters like ':' which are invalid on some platforms (e.g. Windows).
const label = `-${event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')}`

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
  tempDir: `.nyc_output-node-${process.version}${label}`,
  reportDir: `coverage-node-${process.version}${label}`,
  // TODO: Enable once integration tests are counted. Instrumentations are
  // currently not tracked and counted and that would decrease our coverage
  // report by about 25%.
  all: false,
  // Baseline coverage is disabled because some of our CI suites only run
  // coverage on a small subset of the codebase. The only value we may trust is
  // the combined coverage of all suites.
  'check-coverage': false
}
