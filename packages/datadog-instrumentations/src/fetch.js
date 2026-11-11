'use strict'

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

  globalThis.fetch = function fetch (input, init) {
    return wrappedFetch(input, init)
  }
}
