'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const startChannel = channel('apm:fetch:request:start')
const finishChannel = channel('apm:fetch:request:finish')
const errorChannel = channel('apm:fetch:request:error')

class DDRequest extends Request {
  constructor (input, init) {
    super(...arguments)
    if (input instanceof DDRequest) {
      this.isNativeReadableStream = input.isNativeReadableStream
    } else {
      this.isNativeReadableStream = !!init?.duplex
    }
  }
}

function wrapFetch (fetch, Request) {
  if (typeof fetch !== 'function') return fetch

  return function (input, init) {
    if (!startChannel.hasSubscribers) return fetch.apply(this, arguments)

    const req = new Request(input, init)
    const headers = req.headers
    const message = { req, headers }

    let body
    if (
      (input instanceof Request && input.isNativeReadableStream) ||
      init?.body instanceof ReadableStream
    ) {
      // If we're actually setting up a duplex stream for the request, we don't
      // want to consume it.
      // Otherwise, we have ReadableStream bodies only because Request objects
      // transforms all passed body types into streams, so we can use these
      // without breaking anything .
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
  globalThis.Request = DDRequest
  globalThis.fetch = shimmer.wrap(fetch, wrapFetch(fetch, globalThis.Request))
}
