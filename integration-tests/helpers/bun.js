'use strict'

const { join, resolve } = require('path')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BUN_INSTALL = join(PROJECT_ROOT, 'node_modules', '.cache', 'bun')
const BUN = join(PROJECT_ROOT, 'node_modules', '.bin', 'bun')

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function withBun (env = process.env) {
  return /** @type {NodeJS.ProcessEnv & { BUN_INSTALL: string, _DD_IGNORE_ENGINES: boolean }} */ (
    { ...env, BUN_INSTALL, _DD_IGNORE_ENGINES: true }
  )
}

module.exports = { BUN, withBun }
