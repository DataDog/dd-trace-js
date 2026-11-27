'use strict'

const { spawn } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')

// Experiment: run the same mocha processes without collecting coverage.
const mochaArgs = [mochaBin, ...process.argv.slice(2)]

/**
 * Run one covered Mocha process for every set of environment overrides, then merge their profiles.
 *
 * @param {Array<typeof process.env>} [environmentOverrides]
 */
async function runCoverageSuite (environmentOverrides = [{}]) {
  try {
    const coverageEnv = { ...process.env }

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

    process.exitCode = statuses.find(status => status !== 0) || 0
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) runCoverageSuite()

module.exports = { runCoverageSuite }
