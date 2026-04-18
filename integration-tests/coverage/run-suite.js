'use strict'

// Entry point for coverage-enabled integration test runs. Forwards CLI args to Mocha, then
// always invokes the merge step so partial coverage is produced even if some tests fail.
const { spawnSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const { scriptLabel } = require('./runtime')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const mergeScript = path.join(__dirname, 'merge-lcov.js')
const registerScript = path.join(__dirname, 'register.js')

// Per-script tarball cache so two `*:coverage` runs in the same checkout don't race on a
// single `/tmp` file; `createSandbox` reuses the tarball if it exists, skipping `bun pm pack`.
if (!process.env.DD_TEST_SANDBOX_TARBALL_PATH) {
  const label = scriptLabel() || 'default'
  process.env.DD_TEST_SANDBOX_TARBALL_PATH = path.join(os.tmpdir(), `dd-trace-coverage-sandbox-${label}.tgz`)
}

const spawnOptions = { cwd: repoRoot, env: process.env, stdio: 'inherit' }
const mochaResult = spawnSync(
  process.execPath,
  [mochaBin, '--require', registerScript, ...process.argv.slice(2)],
  spawnOptions,
)
const mergeResult = spawnSync(process.execPath, [mergeScript], spawnOptions)

// Fall through to the merger's status only when mocha passed cleanly; preserve signal deaths as 1.
process.exitCode = (mochaResult.status ?? 1) || (mergeResult.status ?? 1)
