'use strict'

const baseConfig = require('../../nyc.config')
const { ROOT_ENV, canonicalizePath, getSandboxNycPaths, isPreInstrumentedSandbox } = require('./runtime')

/**
 * @param {string} [coverageRoot]
 * @returns {Record<string, unknown>}
 */
function createConfig (coverageRoot = process.env[ROOT_ENV] || process.cwd()) {
  const canonicalRoot = canonicalizePath(coverageRoot)
  const { reportDir, tempDir } = getSandboxNycPaths(canonicalRoot)
  const preInstrumented = isPreInstrumentedSandbox(canonicalRoot)
  return {
    ...baseConfig,
    cache: false,
    hookRequire: !preInstrumented,
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
