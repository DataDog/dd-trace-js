'use strict'

const { join, resolve } = require('path')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BUN_INSTALL = join(PROJECT_ROOT, 'node_modules', '.cache', 'bun')
const BUN = join(PROJECT_ROOT, 'node_modules', '.bin', 'bun')

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv & { BUN_INSTALL: string }}
 */
function withBun (env = process.env) {
  return { ...env, BUN_INSTALL }
}

module.exports = { BUN, withBun }
