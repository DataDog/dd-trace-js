'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */
// Only loaded under Bun, which implements Fetch APIs independently of Node.js.

const { AsyncResource } = require('node:async_hooks')

const shimmer = require('../../datadog-shimmer')
const requests = require('./helpers/bun-requests')
const { channel } = require('./helpers/instrument')

const start = channel('apm:http:server:request:start')
const exit = channel('apm:http:server:request:exit')
const finish = channel('apm:http:server:request:finish')
const errorChannel = channel('apm:bun:server:request:error')
const routeChannel = channel('apm:bun:server:request:route')
const load = channel('dd-trace:instrumentation:load')
const incomingRequest = channel('dd-trace:incomingHttpRequestStart')

// Bun.serve is a native runtime function, so source rewriting cannot intercept it.
shimmer.wrap(globalThis.Bun, 'serve', serve => function (options, ...args) {
  load.publish({ name: 'http' })
  if (!start.hasSubscribers) return serve.call(this, options, ...args)

  const errors = new Map()
  const upgraded = new WeakSet()
  const handlers = {}
  const server = serve.call(this, wrapOptions(options, errors, upgraded, handlers), ...args)
  shimmer.wrap(server, 'upgrade', upgrade => function (request) {
    const result = upgrade.apply(this, arguments)
    if (result) upgraded.add(request)
    return result
  })
  shimmer.wrap(server, 'reload', reload => function (options) {
    return reload.call(this, wrapOptions(options, errors, upgraded, handlers))
  })
  return server
})

/**
 * @param {{ fetch?: (request: Request, server: object) => unknown, error?: (error: unknown) => unknown,
 * routes?: Record<string, unknown> }} options
 * @param {Map<Request, { error: unknown, handle: (error: unknown) => unknown }>} errors
 * @param {WeakSet<Request>} upgraded
 * @param {{ error?: (error: unknown) => unknown }} handlers
 */
function wrapOptions (options, errors, upgraded, handlers) {
  if (!start.hasSubscribers || !options ||
    (options.fetch !== undefined && typeof options.fetch !== 'function') ||
    (options.error && typeof options.error !== 'function')) {
    return options
  }

  if (options.error) handlers.error = options.error
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
    const ctx = { req, res }
    if (incomingRequest.hasSubscribers) ctx.abortController = new AbortController()
    requests.set(request, req)
    let finished = false
    let signal

    const complete = response => {
      if (!finished) {
        finished = true
        errors.delete(request)
        signal?.removeEventListener('abort', onAbort)
        if (response instanceof Response) {
          res.headers = response.headers
          res.writeHead(response.status)
        } else if (upgraded.has(request)) {
          res.statusCode = 101
        } else if (!req.aborted) {
          res.statusCode = 500
        }
        finish.publish(ctx)
        if (response instanceof Response && res.headersChanged) {
          // Redirects and fetch() responses can have immutable headers.
          response = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: res.headers,
          })
        }
      }
      return response
    }
    const onAbort = () => {
      req.aborted = true
      complete()
    }

    const wait = (result, onError = fail) => {
      if (!finished && !signal) {
        signal = request.signal
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
      return result.then(complete, onError)
    }

    const fail = error => {
      errorChannel.publish({ req, error })
      if (!finished) {
        errors.set(request, {
          error,
          // Bun invokes its error callback outside the fetch handler's async context.
          handle: AsyncResource.bind(function () {
            try {
              const result = handlers.error?.apply(this, arguments)
              return result && typeof result.then === 'function'
                ? wait(result, error => { complete(); throw error })
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
          ? wait(result)
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
      // Bun dispatches error callbacks in rejection order, without a Request argument.
      // Keep one entry per request, including when applications reuse an Error.
      for (const [request, entry] of errors) {
        if (Object.is(entry.error, error)) {
          errors.delete(request)
          return entry.handle.apply(this, arguments)
        }
      }
      return handlers.error?.apply(this, arguments)
    },
  }

  if (typeof options.fetch === 'function') wrappedOptions.fetch = wrapHandler(options.fetch)
  if (options.routes && typeof options.routes === 'object' && !Array.isArray(options.routes)) {
    wrappedOptions.routes = Object.fromEntries(Object.entries(options.routes).map(([route, handler]) => {
      const wrapRoute = handler => {
        if (typeof handler === 'function') return wrapHandler(handler, route)
        // Static Responses must stay on Bun's native zero-JavaScript fast path.
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

  return wrappedOptions
}

// The HTTP plugin consumes this small ServerResponse contract, not a Node socket.
class ResponseAdapter {
  headers
  headersChanged = false
  statusCode = 200

  /** @param {number} statusCode */
  writeHead (statusCode) {
    this.statusCode = statusCode
  }

  /** @param {string} name */
  getHeader (name) {
    return this.headers?.get(name) ?? undefined
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  setHeader (name, value) {
    if (this.getHeader(name) === value) return
    if (!this.headersChanged) {
      this.headers = new Headers(this.headers)
      this.headersChanged = true
    }
    this.headers.set(name, value)
  }
}
