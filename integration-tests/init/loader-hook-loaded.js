'use strict'

const path = require('node:path')

const hooksPath = require.resolve(path.join(
  process.env.DD_TEST_TRACER_ROOT,
  'packages/datadog-instrumentations/src/helpers/hooks.js'
))

// eslint-disable-next-line no-console
console.log(require.cache[hooksPath] !== undefined)
