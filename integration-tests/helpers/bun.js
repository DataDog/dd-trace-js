'use strict'

const { join, resolve } = require('path')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BUN_INSTALL = join(PROJECT_ROOT, 'node_modules', '.cache', 'bun')
const BUN = join(PROJECT_ROOT, 'node_modules', '.bin', 'bun')

/**
 * @param {typeof process.env} [env]
 * @returns {typeof process.env & { BUN_INSTALL: string }}
 */
function withBun (env = process.env) {
  return { ...env, BUN_INSTALL }
}

module.exports = { BUN, withBun }
