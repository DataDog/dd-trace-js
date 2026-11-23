'use strict'

const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../version')

/**
 * Whether this Node.js release fixed `module.registerHooks` (nodejs/node#59929, released in 22.22.3, 24.11.1, 25.1.0
 * and 26.0.0), so dd-trace can load modules through synchronous hooks.
 */
function isSyncLoaderHookVersionSupported () {
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}

module.exports = { isSyncLoaderHookVersionSupported }
