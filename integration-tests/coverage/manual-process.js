'use strict'

const path = require('node:path')

const { applyCoverageEnv } = require('./runtime')

/**
 * Builds an env for wrappers that spawn Node.js indirectly (e.g. `func`, `cypress`, `playwright`)
 * where `child_process` patching can't reach the inner Node process.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.scriptPath]
 * @returns {NodeJS.ProcessEnv}
 */
function buildManualCoverageEnv ({ cwd, env = {}, scriptPath }) {
  const resolved = scriptPath || path.join(cwd, 'node_modules', 'dd-trace', 'loader-hook.mjs')
  return applyCoverageEnv(env, { cwd, scriptPath: resolved }) || { ...env }
}

module.exports = {
  buildManualCoverageEnv,
}
