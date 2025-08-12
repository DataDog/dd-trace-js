'use strict'

const { isInServerlessEnvironment } = require('../../dd-trace/src/serverless')

if (globalThis.fetch) {
  const globalFetch = globalThis.fetch

  let fetch = (input, init) => {
    wrapRealFetch()

    return fetch(input, init)
  }

  function wrapRealFetch () {
    const { channel, tracingChannel } = require('dc-polyfill')
    const { createWrapFetch } = require('./helpers/fetch')

    const ch = tracingChannel('apm:fetch:request')
    const wrapFetch = createWrapFetch(globalThis.Request, ch, () => {
      channel('dd-trace:instrumentation:load').publish({ name: 'global:fetch' })
    })

    fetch = wrapFetch(globalFetch)
  }

  if (!isInServerlessEnvironment()) {
    wrapRealFetch()
  }

  globalThis.fetch = function value (input, init) {
    return fetch(input, init)
  }
}
