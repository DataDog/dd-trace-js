'use strict'

const { join, resolve } = require('path')

const { dependencies } = require('../../packages/dd-trace/test/plugins/versions/package.json')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BUN_INSTALL = join(PROJECT_ROOT, 'node_modules', '.cache', 'bun')
const BUN = join(PROJECT_ROOT, 'node_modules', '.bin', 'bun')
const BUN_CONFIG = join(PROJECT_ROOT, 'bunfig.toml')
const YARN = `"${BUN}" x yarn@${dependencies.yarn}`

/**
 * @param {typeof process.env} [env]
 * @returns {typeof process.env & { BUN_INSTALL: string }}
 */
function withBun (env = process.env) {
  return { ...env, BUN_INSTALL }
}

module.exports = { BUN, BUN_CONFIG, YARN, withBun }
