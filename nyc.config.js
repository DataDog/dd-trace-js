'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

// Include the current npm script name (when available) so coverage artifacts are attributable.
let event = process.env.npm_lifecycle_event ?? ''

if (process.env.PLUGINS) {
  event += `-${process.env.PLUGINS}`
}

// Script names may include characters like ':' which are invalid on some platforms (e.g. Windows).
const label = `-${event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')}`

module.exports = {
  reporter: [
    'text',
    'lcov',
  ],
  include: [
    '**/ext/**/*.{js,mjs}',
    '**/packages/**/src/**/*.{js,mjs}',
    '**/packages/*/*.{js,mjs}',
    'index.js',
    'init.js',
    'initialize.mjs',
    'loader-hook.mjs',
    'register.js',
    'version.js',
  ],
  exclude: [
    '**/.bun/**',
    '**/*.spec.*',
    '**/fixtures/**',
    '**/integration-tests/**',
    '**/resources/**',
    '**/test/**',
    '**/vendor/**',
  ],
  // Avoid collisions when a single CI job runs coverage sequentially across multiple Node.js versions.
  tempDir: `.nyc_output-node-${process.version}${label}`,
  reportDir: `coverage-node-${process.version}${label}`,
  // Not tracking all coverage has the downside to potentially miss some code
  // paths and files that we do not use anymore. Doing so is just going to
  // report lots of files in tests that are empty and that is more confusing.
  all: false,
  // Baseline coverage is disabled because some of our CI suites only run
  // coverage on a small subset of the codebase. The only value we may trust is
  // the combined coverage of all suites.
  'check-coverage': false,
}
