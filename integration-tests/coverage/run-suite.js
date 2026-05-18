'use strict'

const { spawnSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { scriptLabel } = require('./runtime')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const mergeScript = path.join(__dirname, 'merge-lcov.js')
const registerScript = path.join(__dirname, 'register.js')

// The tarball cache key (script label) is stable across runs, so on persistent
// environments (local dev, self-hosted runners) a stale tarball from a previous
// checkout would otherwise be silently reused. Force a fresh pack each run.
if (!process.env.DD_TEST_SANDBOX_TARBALL_PATH) {
  const label = scriptLabel() || 'default'
  process.env.DD_TEST_SANDBOX_TARBALL_PATH = path.join(os.tmpdir(), `dd-trace-coverage-sandbox-${label}.tgz`)
}
rmSync(process.env.DD_TEST_SANDBOX_TARBALL_PATH, { force: true })
rmSync(`${process.env.DD_TEST_SANDBOX_TARBALL_PATH}.lock`, { force: true })

const spawnOptions = { cwd: repoRoot, env: process.env, stdio: 'inherit' }
const mochaResult = spawnSync(
  process.execPath,
  [mochaBin, '--require', registerScript, ...process.argv.slice(2)],
  spawnOptions,
)
const mergeResult = spawnSync(process.execPath, [mergeScript], spawnOptions)

process.exitCode = (mochaResult.status ?? 1) || (mergeResult.status ?? 1)
