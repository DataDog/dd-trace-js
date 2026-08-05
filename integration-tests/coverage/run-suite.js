'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { V8_COVERAGE_ENV, getV8CoverageDir, resetCollectorRoot } = require('./runtime')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const mergeScript = path.join(__dirname, 'merge-lcov.js')
const registerScript = path.join(__dirname, 'register.js')

// Reset the collector once, here in the parent, before V8 opens any coverage file: register.js
// must not wipe it out from under the running mocha process. Point this mocha process' own
// NODE_V8_COVERAGE at the shared collector dir so the driver process is covered too, and the
// child-process patch (installed by register.js) carries the same directory into every sandbox.
resetCollectorRoot()
const env = { ...process.env, [V8_COVERAGE_ENV]: getV8CoverageDir() }

const spawnOptions = { cwd: repoRoot, env, stdio: 'inherit' }
const mochaResult = spawnSync(
  process.execPath,
  [mochaBin, '--require', registerScript, ...process.argv.slice(2)],
  spawnOptions,
)
// merge-lcov converts every per-process V8 profile in the collector into one istanbul lcov report.
const mergeResult = spawnSync(process.execPath, [mergeScript], { cwd: repoRoot, env: process.env, stdio: 'inherit' })

process.exitCode = (mochaResult.status ?? 1) || (mergeResult.status ?? 1)
