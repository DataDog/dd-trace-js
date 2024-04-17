'use strict'

const shimmer = require('../../datadog-shimmer')
const { tracingChannel } = require('dc-polyfill')
const { createWrapFetch } = require('./helpers/fetch')

if (globalThis.fetch) {
  const ch = tracingChannel('apm:fetch:request')
  const wrapFetch = createWrapFetch(globalThis.Request, ch)

  globalThis.fetch = shimmer.wrap(fetch, wrapFetch(fetch))
}
