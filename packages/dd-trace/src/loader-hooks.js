'use strict'

const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../version')

/**
 * Registers the synchronous loader hooks when the runtime supports them, and
 * reports whether they were registered so callers can fall back to `register`.
 */
function registerSyncHooks () {
  if (!shouldRegisterSyncLoaderHooks()) return false

  let syncRegistrationError
  try {
    const { registerSyncLoaderHooks } = require('../../../loader-hook.mjs')
    if (registerSyncLoaderHooks?.()) return true
  } catch (error) {
    syncRegistrationError = error
  }

  warnSyncLoaderFallback(syncRegistrationError)
  return false
}

function shouldRegisterSyncLoaderHooks () {
  if (!isSyncLoaderHookVersionSupported()) {
    return false
  }

  try {
    return require('import-in-the-middle/create-hook.mjs').supportsSyncHooks()
  } catch (error) {
    if (error?.code !== 'ERR_REQUIRE_ESM') {
      warnSyncLoaderFallback(error)
    }
  }

  return false
}

function isSyncLoaderHookVersionSupported () {
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}

function warnSyncLoaderFallback (error) {
  let message = 'dd-trace could not register synchronous loader hooks. Falling back to the asynchronous loader.'

  if (error?.message) {
    message += ` ${error.message}`
  }

  process.emitWarning(message)
}

module.exports = { registerSyncHooks }
