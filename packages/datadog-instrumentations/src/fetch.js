'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const startChannel = channel('apm:fetch:request:start')
const finishChannel = channel('apm:fetch:request:finish')
const errorChannel = channel('apm:fetch:request:error')

function wrapFetch (fetch, Request) {
  if (typeof fetch !== 'function') return fetch

  return function (input, init) {
    if (!startChannel.hasSubscribers) return fetch.apply(this, arguments)

    const req = new Request(input, init)
    const headers = req.headers
    const message = { req, headers }

    return startChannel.runStores(message, () => {
      // Request object is read-only so we need new objects to change headers.
      arguments[0] = message.req
      arguments[1] = { headers: message.headers }

      return fetch.apply(this, arguments)
        .then(
          res => {
            message.res = res

            finishChannel.publish(message)

            return res
          },
          err => {
            if (err.name !== 'AbortError') {
              message.error = err
              errorChannel.publish(message)
            }

            finishChannel.publish(message)

            throw err
          }
        )
    })
  }
}

if (globalThis.fetch) {
  globalThis.fetch = shimmer.wrap(fetch, wrapFetch(fetch, globalThis.Request))
}
