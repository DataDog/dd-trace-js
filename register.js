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
    if (e?.code !== 'ERR_REQUIRE_ESM') throw e
  }

  if (registerSyncLoaderHooks) {
    isSyncLoaderRegistered = registerSyncLoaderHooks()
    if (!isSyncLoaderRegistered) {
      throw new Error('Synchronous loader hooks are supported but dd-trace could not register them.')
    }
  }
}

if (!isSyncLoaderRegistered) {
  register('./loader-hook.mjs', parentURL)
}

function supportsSyncLoaderHooks () {
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}
