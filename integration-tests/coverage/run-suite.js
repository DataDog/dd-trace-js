'use strict'

// Entry point for coverage-enabled integration test runs. Forwards CLI args to Mocha, then
// always invokes the merge step so partial coverage is produced even if some tests fail.
const { spawnSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const mergeScript = path.join(__dirname, 'merge-lcov.js')
const registerScript = path.join(__dirname, 'register.js')

// Share a single cached dd-trace tarball across every sandbox: `createSandbox` reuses the tarball
// if it exists, eliminating the repeated multi-second `bun pm pack` step.
if (!process.env.DD_TEST_SANDBOX_TARBALL_PATH) {
  process.env.DD_TEST_SANDBOX_TARBALL_PATH = path.join(os.tmpdir(), 'dd-trace-coverage-sandbox.tgz')
}

const spawnOptions = { cwd: repoRoot, env: process.env, stdio: 'inherit' }
const mochaResult = spawnSync(
  process.execPath,
  [mochaBin, '--require', registerScript, ...process.argv.slice(2)],
  spawnOptions,
)
const mergeResult = spawnSync(process.execPath, [mergeScript], spawnOptions)

process.exitCode = mochaResult.status !== 0 ? mochaResult.status ?? 1 : mergeResult.status ?? 1
