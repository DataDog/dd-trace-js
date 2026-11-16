'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */
// Only loaded under Bun, which implements Fetch APIs independently of Node.js.

const { AsyncResource } = require('node:async_hooks')

const shimmer = require('../../datadog-shimmer')
const requests = require('./helpers/bun')
const { channel } = require('./helpers/instrument')

const start = channel('apm:http:server:request:start')
const exit = channel('apm:http:server:request:exit')
const finish = channel('apm:http:server:request:finish')
const errorChannel = channel('apm:bun:server:request:error')
const routeChannel = channel('apm:bun:server:request:route')
const load = channel('dd-trace:instrumentation:load')

// Bun.serve is a native runtime function, so source rewriting cannot intercept it.
shimmer.wrap(globalThis.Bun, 'serve', serve => function (options, ...args) {
  load.publish({ name: 'http' })
  if (!options ||
    (options.fetch !== undefined && typeof options.fetch !== 'function') ||
    (options.error && typeof options.error !== 'function')) {
    return serve.call(this, options, ...args)
  }

  const errors = new Map()
  const onError = options.error
  const wrapHandler = (fetch, route) => function (request, server) {
    if (!start.hasSubscribers) return fetch.apply(this, arguments)

    const url = new URL(request.url)
    const address = server.requestIP(request)
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      socket: { encrypted: url.protocol === 'https:', remoteAddress: address?.address },
    }
    const res = new ResponseAdapter()
    const ctx = { req, res, abortController: new AbortController() }
    requests.set(request, req)
    let finished = false
    let failure

    const complete = response => {
      if (!finished) {
        finished = true
        if (errors.get(failure)?.complete === complete) errors.delete(failure)
        request.signal.removeEventListener('abort', onAbort)
        if (response instanceof Response) {
          res.headers = new Headers(response.headers)
          res.writeHead(response.status)
          // Redirects and fetch() responses can have immutable headers.
          if ([...res.headers].some(([key, value]) => response.headers.get(key) !== value)) {
            response = new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers: res.headers,
            })
          }
        } else {
          res.statusCode = 500
        }
        finish.publish(ctx)
      }
      return response
    }
    const onAbort = () => complete()
    request.signal.addEventListener('abort', onAbort, { once: true })

    const fail = error => {
      errorChannel.publish({ req, error })
      failure = error
      if (!finished) {
        errors.set(error, {
          complete,
          // Bun invokes its error callback outside the fetch handler's async context.
          handle: AsyncResource.bind(function () {
            try {
              const result = onError?.apply(this, arguments)
              return result && typeof result.then === 'function'
                ? result.then(complete, error => { complete(); throw error })
                : complete(result)
            } catch (error) {
              complete()
              throw error
            }
          }),
        })
      }
      throw error
    }

    const resource = new AsyncResource('Bun.serve')
    return resource.runInAsyncScope(() => {
      start.publish(ctx)
      if (route) routeChannel.publish({ req, route })
      try {
        const result = fetch.call(this, request, server)
        return result && typeof result.then === 'function'
          ? result.then(complete, fail)
          : complete(result)
      } catch (error) {
        return fail(error)
      } finally {
        exit.publish(ctx)
        resource.emitDestroy()
      }
    })
  }
  const wrappedOptions = {
    ...options,
    error (error) {
      const entry = errors.get(error)
      errors.delete(error)
      return entry ? entry.handle.apply(this, arguments) : onError?.apply(this, arguments)
    },
  }

  if (typeof options.fetch === 'function') wrappedOptions.fetch = wrapHandler(options.fetch)
  if (options.routes && typeof options.routes === 'object' && !Array.isArray(options.routes)) {
    wrappedOptions.routes = Object.fromEntries(Object.entries(options.routes).map(([route, handler]) => {
      const wrapRoute = handler => {
        if (typeof handler === 'function') return wrapHandler(handler, route)
        if (handler instanceof Response) return wrapHandler(() => handler.clone(), route)
        return handler
      }
      if (handler && Object.getPrototypeOf(handler) === Object.prototype) {
        handler = Object.fromEntries(Object.entries(handler).map(([method, handler]) => [method, wrapRoute(handler)]))
      } else {
        handler = wrapRoute(handler)
      }
      return [route, handler]
    }))
  }

  return serve.call(this, wrappedOptions, ...args)
})

// The HTTP plugin consumes this small ServerResponse contract, not a Node socket.
class ResponseAdapter {
  headers = new Headers()
  statusCode = 200

  /** @param {number} statusCode */
  writeHead (statusCode) {
    this.statusCode = statusCode
  }

  /** @param {string} name */
  getHeader (name) {
    return this.headers.get(name) ?? undefined
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  setHeader (name, value) {
    this.headers.set(name, value)
  }
}
