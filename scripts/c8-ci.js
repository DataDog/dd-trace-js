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
const baseNycConfig = require('../nyc.config')
const { markCoverageDirectory } = require('./c8-source-map-cache')

const repoRoot = path.resolve(__dirname, '..')
const sourceMapCacheFile = require.resolve('./c8-source-map-cache')

const directNode = process.argv[2] === '--node'
const [script, ...extraArgs] = process.argv.slice(directNode ? 3 : 2)
if (!script || (directNode && extraArgs.length === 0)) {
  process.stderr.write('usage: node scripts/c8-ci.js [--node] <npm-script> [args...]\n')
  process.exit(1)
}

const v8Dir = path.join(repoRoot, baseNycConfig.tempDir, 'v8')
const reportDir = path.join(repoRoot, baseNycConfig.reportDir)

// Fresh collector each run so a previous run's profiles don't leak in.
rmSync(v8Dir, { force: true, recursive: true })
rmSync(reportDir, { force: true, recursive: true })
markCoverageDirectory(v8Dir)

const sourceMapCacheRequire = `--require=${sourceMapCacheFile}`
const nodeOptions = process.env.NODE_OPTIONS
  ? `${sourceMapCacheRequire} ${process.env.NODE_OPTIONS}`
  : sourceMapCacheRequire
const coverageEnv = { ...process.env, NODE_OPTIONS: nodeOptions, NODE_V8_COVERAGE: v8Dir }

/**
 * @param {string[]} command command + args to run with V8 coverage enabled
 * @param {typeof process.env} [env]
 */
function runCovered (command, env = coverageEnv) {
  const { status } = spawnSync(command[0], command.slice(1), { cwd: repoRoot, env, stdio: 'inherit' })
  return status ?? 1
}

const warmup = runCovered([process.execPath, 'init'])
if (warmup !== 0) process.exit(warmup)

// Resolve npm the same way the package-script lifecycle does. `npm_execpath` is set
// on the real CI path; direct invocations fall back to npm from PATH.
const pmExecpath = process.env.npm_execpath
const runner = pmExecpath ? [process.execPath, pmExecpath] : ['npm']
const testStatus = directNode
  ? runCovered([process.execPath, ...extraArgs], { ...coverageEnv, npm_lifecycle_event: script })
  : runCovered([...runner, 'run', script, '--', ...extraArgs])

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
