'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('./version')

const parentURL = pathToFileURL(__filename)
let isSyncLoaderRegistered = false

if (shouldRegisterSyncLoaderHooks()) {
  let registerSyncLoaderHooks
  let syncRegistrationError
  try {
    ({ registerSyncLoaderHooks } = require('./loader-hook.mjs'))
    if (registerSyncLoaderHooks) {
      isSyncLoaderRegistered = registerSyncLoaderHooks()
    }
  } catch (error) {
    syncRegistrationError = error
  }

  if (!isSyncLoaderRegistered) {
    warnSyncLoaderFallback(syncRegistrationError)
  }
}

if (!isSyncLoaderRegistered) {
  register('./loader-hook.mjs', parentURL)
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
