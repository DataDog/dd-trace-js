'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')

const registerLoader = require('./packages/dd-trace/src/register-loader')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('./version')

registerLoader(register, pathToFileURL(__filename), tryRegisterSyncLoader)

function tryRegisterSyncLoader () {
  if (!isSyncLoaderHookVersionSupported()) return

  try {
    if (!require('import-in-the-middle/create-hook.mjs').supportsSyncHooks()) return
  } catch (error) {
    if (error?.code === 'ERR_REQUIRE_ESM') return
    throw error
  }

  const { registerSyncLoaderHooks } = require('./loader-hook.mjs')
  return registerSyncLoaderHooks?.() ?? false
}

function isSyncLoaderHookVersionSupported () {
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}
