#!/usr/bin/env node

'use strict'

// Run an in-process `test:*` suite under native V8 coverage, replacing the old
// `nyc --silent node init && nyc -- npm run test:X` pattern.
//
// We drive V8 coverage directly via NODE_V8_COVERAGE (rather than the c8 CLI, whose bundled yargs
// entrypoint fails to load on newer Node) and convert the collected profiles with the same patched
// v8-to-istanbul pipeline the integration harness uses, so every suite reports through one code
// path. Two passes share the collector directory:
//   1. `node init` — warms up / exercises tracer initialization (kept from the nyc flow).
//   2. the test suite itself.
// The merged report lands in `coverage/node-<version><-label>` — the same version/label keyed
// layout `scripts/verify-coverage.js` expects, so parallel Node.js versions in one CI job don't
// collide. The multi-line-statement over-report fix lives in `scripts/patch-v8-to-istanbul.js`
// (applied in `prepare`).

const { spawnSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const path = require('node:path')

const { convertV8DirToReport } = require('../integration-tests/coverage/merge-lcov')

const repoRoot = path.resolve(__dirname, '..')

const script = process.argv[2]
if (!script) {
  process.stderr.write('usage: node scripts/c8-ci.js <npm-script> [extra npm args...]\n')
  process.exit(1)
}
const extraArgs = process.argv.slice(3)

let event = process.env.npm_lifecycle_event ?? ''
if (process.env.PLUGINS) event += `-${process.env.PLUGINS}`
const label = `-${event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')}`
const v8Dir = path.join(repoRoot, '.nyc_output', `node-${process.version}${label}`, 'v8')
const reportDir = path.join(repoRoot, 'coverage', `node-${process.version}${label}`)

// Fresh collector each run so a previous run's profiles don't leak in.
rmSync(v8Dir, { force: true, recursive: true })
rmSync(reportDir, { force: true, recursive: true })

const coverageEnv = { ...process.env, NODE_V8_COVERAGE: v8Dir }

/**
 * @param {string[]} command command + args to run with V8 coverage enabled
 * @returns {number} exit status
 */
function runCovered (command) {
  const { status } = spawnSync(command[0], command.slice(1), { cwd: repoRoot, env: coverageEnv, stdio: 'inherit' })
  return status ?? 1
}

const warmup = runCovered([process.execPath, 'init'])
if (warmup !== 0) process.exit(warmup)

// Resolve the package manager the same way the npm/yarn lifecycle would. `npm_execpath` is set
// when invoked through a package script (the real CI path); fall back to yarn, the repo's PM.
const pmExecpath = process.env.npm_execpath
const runner = pmExecpath ? [process.execPath, pmExecpath] : ['yarn']
const testStatus = runCovered([...runner, 'run', script, ...extraArgs])

convertV8DirToReport(v8Dir, reportDir)
  .then(({ scripts, profiles, files }) => {
    process.stdout.write(files === 0
      ? 'No V8 coverage data found to report.\n'
      : `Converted ${scripts} V8 script entries across ${profiles} profile(s) into ${files} file section(s).\n`)
    process.exit(testStatus)
  })
  .catch(err => {
    process.stderr.write(`${err.stack || err.message}\n`)
    process.exit(testStatus || 1)
  })
