'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=20.6.0', allowExperimental: true }] */

const { register } = require('node:module')
const { pathToFileURL } = require('node:url')

register('./loader-hook.mjs', pathToFileURL(__filename), {
  data: { exclude: [/langsmith/, /openai\/_shims/, /openai\/resources\/chat\/completions\/messages/] }
})
