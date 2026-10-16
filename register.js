'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const { registerSyncHooks } = require('./packages/dd-trace/src/loader-hooks')

if (!registerSyncHooks()) {
  register('./loader-hook.mjs', pathToFileURL(__filename))
}
