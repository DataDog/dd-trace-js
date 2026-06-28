'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const { syncLoaderHooksSupported } = require('./packages/dd-trace/src/supported-loader-hooks')

const parentURL = pathToFileURL(__filename)

// Node caches this module, so its body runs once per process even when both the
// `--import` entry and the CommonJS init path load it. Record that the loader
// hooks were registered here so initialize.mjs does not also register the async
// loader (it reaches Module.register on a separate path, which the module cache
// can't dedupe for us).
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

globalThis[Symbol.for('dd-trace:loader-hooks-registered')] = true

function shouldRegisterSyncLoaderHooks () {
  if (!syncLoaderHooksSupported()) {
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

function warnSyncLoaderFallback (error) {
  let message = 'dd-trace could not register synchronous loader hooks. Falling back to the asynchronous loader.'

  if (error?.message) {
    message += ` ${error.message}`
  }

  process.emitWarning(message)
}
