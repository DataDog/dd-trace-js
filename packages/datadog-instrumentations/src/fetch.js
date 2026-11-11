'use strict'

const { IS_SERVERLESS } = require('../../dd-trace/src/serverless')

if (globalThis.fetch) {
  const globalFetch = globalThis.fetch

  let wrappedFetch = (input, init) => {
    wrapRealFetch()

    return wrappedFetch(input, init)
  }

  function wrapRealFetch () {
    const { channel, tracingChannel } = require('dc-polyfill')
    const { createWrapFetch } = require('./helpers/fetch')

    const ch = tracingChannel('apm:fetch:request')
    const wrapFetch = createWrapFetch(globalThis.Request, ch, () => {
      channel('dd-trace:instrumentation:load').publish({ name: 'global:fetch' })
    })

    wrappedFetch = wrapFetch(globalFetch)
  }

  if (!IS_SERVERLESS) {
    wrapRealFetch()
  }

  globalThis.fetch = function fetch (input, init) {
    return wrappedFetch(input, init)
  }
}
