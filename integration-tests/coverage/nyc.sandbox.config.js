'use strict'

const { realpathSync } = require('node:fs')

const baseConfig = require('../../nyc.config')
const { getSandboxNycPaths } = require('./runtime')

/**
 * Sandbox NYC config inheriting `include`/`exclude` from the top-level `nyc.config.js` so
 * adjustments in one place propagate here.
 *
 * @param {string} [coverageRoot]
 * @returns {Record<string, unknown>}
 */
function createConfig (coverageRoot = process.env.DD_TRACE_INTEGRATION_COVERAGE_ROOT || process.cwd()) {
  try { coverageRoot = realpathSync(coverageRoot) } catch {}
  const { reportDir, tempDir } = getSandboxNycPaths(coverageRoot)
  return {
    ...baseConfig,
    cache: false,
    hookRequire: true,
    hookRunInContext: false,
    hookRunInThisContext: false,
    reporter: ['lcov', 'text-summary'],
    reportDir,
    tempDir,
    useSpawnWrap: false,
  }
}

module.exports = createConfig()
module.exports.createConfig = createConfig
