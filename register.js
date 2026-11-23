'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')

const registerLoader = require('./packages/dd-trace/src/register-loader')
const { isSyncLoaderHookVersionSupported } = require('./packages/dd-trace/src/sync-loader-hooks')

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
