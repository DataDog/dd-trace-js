'use strict'

const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../version')

// CommonJS and ESM preloads can both be used in the same process.
/** @type {'sync' | 'async' | undefined} */
let loaderMode

/**
 * @param {typeof import('node:module').register | undefined} registerAsync
 * @param {URL} parentURL
 * @param {() => boolean | undefined} [tryRegisterSync] Returns undefined when sync hooks are unsupported.
 */
function registerLoader (registerAsync, parentURL, tryRegisterSync) {
  if (loaderMode) return

  let syncResult
  let syncError
  try {
    syncResult = tryRegisterSync?.()
  } catch (error) {
    syncResult = false
    syncError = error
  }

  if (syncResult) {
    loaderMode = 'sync'
    return
  }

  if (syncResult === false) {
    let message = 'dd-trace could not register synchronous loader hooks.'
    if (registerAsync) message += ' Falling back to the asynchronous loader.'
    if (syncError?.message) message += ` ${syncError.message}`
    process.emitWarning(message)
  }

  // Node.js removes module.register in nodejs/node#67090.
  if (registerAsync) {
    const { getLoaderRegisterOptions } = require('./esm-module-load')
    registerAsync('./loader-hook.mjs', parentURL, getLoaderRegisterOptions())
    loaderMode = 'async'
  }
}

function getLoaderMode () {
  return loaderMode
}

function isSyncLoaderHookVersionSupported () {
  // Earlier implementations can reject nullish CommonJS source returned by another loader.
  // See nodejs/node#59929.
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}

module.exports = registerLoader
module.exports.getLoaderMode = getLoaderMode
module.exports.isSyncLoaderHookVersionSupported = isSyncLoaderHookVersionSupported
