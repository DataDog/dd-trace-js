'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const path = require('node:path')

// To collect coverage from integration tests that run code in sandboxes under os.tmpdir(),
// we need a cwd that contains both the repo checkout and the sandbox directory.
// Using the filesystem root keeps path normalization stable across processes.
const nycCwd = path.parse(__dirname).root

// Include the current npm script name (when available) so coverage artifacts are attributable.
let event = process.env.npm_lifecycle_event ?? ''

if (process.env.PLUGINS) {
  event += `-${process.env.PLUGINS}`
}

// Script names may include characters like ':' which are invalid on some platforms (e.g. Windows).
const sanitizedEvent = event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
const label = sanitizedEvent ? `-${sanitizedEvent}` : ''

// When running integration tests, we don't want to track coverage for the sandboxed child processes.
// TESTING_NO_INTEGRATION_SANDBOX=true

module.exports = {
  cwd: nycCwd,
  reporter: [
    'text',
    'lcov'
  ],
  // Integration tests run dd-trace from a sandboxed install under node_modules/.
  // We still want to instrument dd-trace's own code there, so we cannot blanket-exclude node_modules.
  excludeNodeModules: false,
  require: [
    path.join(__dirname, 'scripts', 'nyc-child-process-hook.js')
  ],
  include: [
    '**/ext/**/*.{js,mjs}',
    '**/packages/**/src/**/*.{js,mjs}',
    '**/packages/*/*.{js,mjs}',
    path.join(__dirname, 'index.js'),
    path.join(__dirname, 'init.js'),
    path.join(__dirname, 'initialize.mjs'),
    path.join(__dirname, 'loader-hook.mjs'),
    path.join(__dirname, 'register.js'),
    path.join(__dirname, 'version.js'),
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
  // IMPORTANT: Use absolute paths so sandboxed child processes (with different cwd) still write to the same place.
  tempDir: path.join(__dirname, `.nyc_output-node-${process.version}${label}`),
  reportDir: path.join(__dirname, `coverage-node-${process.version}${label}`),
  // Not tracking all coverage has the downside to potentially miss some code
  // paths and files that we do not use anymore. Doing so is just going to
  // report lots of files in tests that are empty and that is more confusing.
  all: false,
  // Baseline coverage is disabled because some of our CI suites only run
  // coverage on a small subset of the codebase. The only value we may trust is
  // the combined coverage of all suites.
  'check-coverage': false
}
