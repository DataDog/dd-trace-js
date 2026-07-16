'use strict'

// Seed ROOT_ENV before requiring `./runtime` so coverage is recognised as active everywhere.
const { realpathSync } = require('node:fs')
const path = require('node:path')
process.env._DD_TRACE_INTEGRATION_COVERAGE_ROOT = realpathSync(path.resolve(__dirname, '..', '..'))

const { installPatch } = require('./patch-child-process')

// run-suite.js already reset the collector and pointed this mocha process' NODE_V8_COVERAGE at it
// (resetting here would wipe the directory out from under the running process). All we do is patch
// child_process / worker_threads so every sandbox and grandchild inherits the coverage directory.
installPatch()
