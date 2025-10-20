'use strict'

const { join, resolve } = require('path')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BUN_INSTALL = join(PROJECT_ROOT, '.bun')
const BUN = join(PROJECT_ROOT, 'node_modules', '.bin', 'bun')

function withBun (env = process.env) {
  return { ...env, BUN_INSTALL, DD_IGNORE_ENGINES: true }
}

module.exports = { BUN, withBun }
