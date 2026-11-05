'use strict'

const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')

const { V8_COVERAGE_ENV, getV8CoverageDir, resetCollectorRoot } = require('./runtime')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const mergeScript = path.join(__dirname, 'merge-lcov.js')
const registerScript = path.join(__dirname, 'register.js')

const mochaArgs = [mochaBin, '--require', registerScript, ...process.argv.slice(2)]

/**
 * Run one covered Mocha process for every set of environment overrides, then merge their profiles.
 *
 * @param {Array<typeof process.env>} [environmentOverrides]
 */
async function runCoverageSuite (environmentOverrides = [{}]) {
  try {
    // Reset the collector once, here in the parent, before V8 opens any coverage file: register.js
    // must not wipe it out from under the running mocha processes.
    resetCollectorRoot()
    const coverageEnv = { ...process.env, [V8_COVERAGE_ENV]: getV8CoverageDir() }

    async function runMocha (extraEnv) {
      const child = spawn(process.execPath, mochaArgs, {
        cwd: repoRoot,
        env: { ...coverageEnv, ...extraEnv },
        stdio: 'inherit',
      })
      const [status] = await once(child, 'exit')
      return status ?? 1
    }

    const statuses = await Promise.all(environmentOverrides.map(runMocha))

    // merge-lcov converts every process' profiles into one Istanbul LCOV report.
    const mergeResult = spawnSync(
      process.execPath,
      [mergeScript],
      { cwd: repoRoot, env: process.env, stdio: 'inherit' }
    )

    process.exitCode = statuses.find(status => status !== 0) || (mergeResult.status ?? 1)
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) runCoverageSuite()

module.exports = { runCoverageSuite }
