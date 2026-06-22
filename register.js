'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('./version')

const parentURL = pathToFileURL(__filename)
const shouldRegisterSyncLoaderHooks = supportsSyncLoaderHooks()
let isSyncLoaderRegistered = false

if (shouldRegisterSyncLoaderHooks) {
  let registerSyncLoaderHooks
  try {
    ({ registerSyncLoaderHooks } = require('./loader-hook.mjs'))
  } catch (e) {
    // `--no-require-module` disables require(esm); keep the asynchronous loader.
    if (e?.code !== 'ERR_REQUIRE_ESM') throw e
  }

  if (registerSyncLoaderHooks) {
    isSyncLoaderRegistered = registerSyncLoaderHooks()
    if (!isSyncLoaderRegistered) {
      // Synchronous hooks were expected on this runtime but import-in-the-middle
      // declined to register them. Warn instead of crashing so the regression is
      // visible while the process still starts on the asynchronous loader below.
      process.emitWarning(
        'dd-trace expected to register synchronous import-in-the-middle loader hooks on this ' +
        'Node.js version but could not; falling back to the asynchronous loader.'
      )
    }
  }
}

if (!isSyncLoaderRegistered) {
  register('./loader-hook.mjs', parentURL)
}

// import-in-the-middle's own `supportsSyncHooks` is the authority on whether the
// synchronous loader can run; loader-hook.mjs gates registration on it. This
// mirror exists only so unsupported runtimes skip requiring the ESM loader — and
// building its code transformer — on the main thread. Because iitm makes the
// final call and registration falls back to the asynchronous loader, a drift
// here costs at most one warned, wasted attempt rather than a crash.
function supportsSyncLoaderHooks () {
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}
