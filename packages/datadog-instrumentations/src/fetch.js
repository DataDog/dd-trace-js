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

    let body
    // We don't want to stream bodies if they involve complex logic.
    // NodeJS fetch implementation forces `duplex` whenever ReadableStream
    // instances are passed, so that's a good marker that we want to leave these alone.
    if (init?.duplex) {
      body = undefined
    } else if (init?.body) {
      body = init.body
    } else if (input instanceof Request && input.body) {
      body = req.clone().body
    } else {
      body = undefined
    }

    return startChannel.runStores({ message, body }, () => {
      // Request object is read-only so we need new objects to change headers.
      arguments[0] = message.req
      message.req = message.req.clone()
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
