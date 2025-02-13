'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, tracingChannel } = require('dc-polyfill')
const { createWrapFetch } = require('./helpers/fetch')

if (globalThis.fetch) {
  const ch = tracingChannel('apm:fetch:request')
  const wrapFetch = createWrapFetch(globalThis.Request, ch, () => {
    channel('dd-trace:instrumentation:load').publish({ name: 'fetch' })
  })

  globalThis.fetch = shimmer.wrapFunction(fetch, fetch => wrapFetch(fetch))
}
