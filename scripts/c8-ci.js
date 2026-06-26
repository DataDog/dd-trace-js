#!/usr/bin/env node

'use strict'

// Run an in-process `test:*` suite under native V8 coverage (c8), replacing the old
// `nyc --silent node init && nyc -- npm run test:X` pattern.
//
// Two coverage passes share one temp directory so coverage accumulates:
//   1. `node init` — warms up / exercises tracer initialization (kept from the nyc flow).
//   2. the test suite itself.
// Only the final pass reports, into `coverage/node-<version><-label>` — the same version/label
// keyed layout `nyc.config.js` and `scripts/verify-coverage.js` expect, so parallel Node.js
// versions in one CI job don't collide. Include/exclude come from `nyc.config.js` so the c8 and
// nyc reporters score an identical file set. The multi-line-statement over-report fix lives in
// `scripts/patch-v8-to-istanbul.js` (applied in `prepare`); c8 uses that patched copy.

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const nycConfig = require('../nyc.config')

const repoRoot = path.resolve(__dirname, '..')
const c8Bin = path.join(repoRoot, 'node_modules', 'c8', 'bin', 'c8.js')

const script = process.argv[2]
if (!script) {
  process.stderr.write('usage: node scripts/c8-ci.js <npm-script> [extra npm args...]\n')
  process.exit(1)
}
const extraArgs = process.argv.slice(3)

let event = process.env.npm_lifecycle_event ?? ''
if (process.env.PLUGINS) event += `-${process.env.PLUGINS}`
const label = `-${event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')}`
const tempDirectory = `.nyc_output/node-${process.version}${label}`
const reportsDirectory = `coverage/node-${process.version}${label}`

const includeArgs = nycConfig.include.flatMap(p => ['--include', p])
const excludeArgs = nycConfig.exclude.flatMap(p => ['--exclude', p])

/**
 * @param {boolean} report whether c8 should emit a report after the run (only the last pass does)
 * @param {string[]} command the command + args c8 should wrap
 * @returns {number} exit status
 */
function runC8 (report, command) {
  const reporterArgs = report
    ? ['--reporter', 'lcovonly', '--reporter', 'text']
    : ['--reporter', 'none']
  const args = [
    c8Bin,
    '--temp-directory', tempDirectory,
    '--reports-dir', reportsDirectory,
    ...reporterArgs,
    ...includeArgs,
    ...excludeArgs,
    '--exclude-node-modules', 'true',
    '--exclude-after-remap',
    '--clean', report ? 'false' : 'true', // first pass cleans stale data; later passes accumulate
    '--', ...command,
  ]
  const { status } = spawnSync(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: 'inherit' })
  return status ?? 1
}

// Warm-up pass (cleans the temp dir), then the suite (reports).
const warmup = runC8(false, [process.execPath, 'init'])
if (warmup !== 0) process.exit(warmup)

// Resolve the package manager the same way the npm/yarn lifecycle would. `npm_execpath` is set
// when invoked through a package script (the real CI path); fall back to yarn, the repo's PM.
const pmExecpath = process.env.npm_execpath
const runner = pmExecpath
  ? [process.execPath, pmExecpath]
  : ['yarn']
const testStatus = runC8(true, [...runner, 'run', script, ...extraArgs])
process.exit(testStatus)
