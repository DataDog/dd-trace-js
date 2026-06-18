'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')

const parentURL = pathToFileURL(__filename)
let isSyncLoaderRegistered = false

try {
  const { registerSyncLoaderHooks } = require('./loader-hook.mjs')
  isSyncLoaderRegistered = registerSyncLoaderHooks()
} catch {}

if (!isSyncLoaderRegistered) {
  register('./loader-hook.mjs', parentURL)
}
