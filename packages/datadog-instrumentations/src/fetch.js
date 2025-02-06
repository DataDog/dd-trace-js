'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['fetch', 'Request'] }] */

const shimmer = require('../../datadog-shimmer')
const { tracingChannel } = require('dc-polyfill')
const { createWrapFetch } = require('./helpers/fetch')

if (globalThis.fetch) {
  const ch = tracingChannel('apm:fetch:request')
  const wrapFetch = createWrapFetch(globalThis.Request, ch)

  globalThis.fetch = shimmer.wrapFunction(fetch, fetch => wrapFetch(fetch))
}
