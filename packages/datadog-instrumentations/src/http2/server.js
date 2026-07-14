'use strict'

const { NODE_MAJOR, NODE_MINOR } = require('../../../../version')
const shimmer = require('../../../datadog-shimmer')
const { FOREIGN_HTTP2_SERVER } = require('../../../dd-trace/src/constants')
const {
  channel,
  addHook,
} = require('../helpers/instrument')

const startServerCh = channel('apm:http2:server:request:start')
const errorServerCh = channel('apm:http2:server:request:error')
const adoptServerCh = channel('apm:http2:server:request:adopt')
const emitCh = channel('apm:http2:server:response:emit')
// Reuse the `http` response-sink channels so the existing AppSec/IAST analyzers
// fire for HTTP/2 too. `Http2ServerResponse` and `Http2Stream` do not share the
// `http.ServerResponse` prototype the `http` instrumentation wraps, so without
// these republications every response-side sink is dead for both HTTP/2 APIs.
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')
const startSetHeaderCh = channel('datadog:http:server:response:set-header:start')
const startWriteHeadCh = channel('apm:http:server:response:writeHead:start')

const HTTP2_HEADER_METHOD = ':method'
const HTTP2_HEADER_PATH = ':path'
const HTTP2_HEADER_STATUS = ':status'
// Node.js started preserving duplicate response header pairs in 20.12.0 and 21.7.0.
const PRESERVES_DUPLICATE_HEADERS = NODE_MAJOR >= 22 ||
  (NODE_MAJOR === 21 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 20 && NODE_MINOR >= 12)

// Streams whose server span was already created from the 'stream' event. The
// compatibility layer synthesizes 'request' from that same stream, so the
// 'request' branch consults this set to avoid creating a second span.
const tracedStreams = new WeakSet()

addHook({ name: 'http2' }, http2 => {
  shimmer.wrap(http2, 'createSecureServer', wrapCreateServer)
  shimmer.wrap(http2, 'createServer', wrapCreateServer)

  const responseProto = http2.Http2ServerResponse?.prototype
  if (responseProto) {
    shimmer.wrap(responseProto, 'end', wrapEnd)
    shimmer.wrap(responseProto, 'setHeader', wrapSetHeader)
    if (responseProto.appendHeader) shimmer.wrap(responseProto, 'appendHeader', wrapSetHeader)
    shimmer.wrap(responseProto, 'write', wrapWrite)
    shimmer.wrap(responseProto, 'writeHead', wrapWriteHead)
  }

  return http2
})

function wrapCreateServer (createServer) {
  return function (...args) {
    const server = createServer.apply(this, args)
    shimmer.wrap(server, 'emit', wrapEmit)
    return server
  }
}

function wrapResponseEmit (originalEmit, ctx) {
  // Named `emit`/arity-1 mirrors the response method so the per-response wrap
  // skips its name/length rewrite.
  return function emit (eventName) {
    ctx.req = this.req
    ctx.eventName = eventName
    return emitCh.runStores(ctx, originalEmit, this, ...arguments)
  }
}

function wrapStreamEmit (originalEmit, ctx) {
  // Named `emit`/arity-1 mirrors the stream method so the per-stream wrap skips
  // its name/length rewrite. `this` is the Http2Stream; the plugin finishes on
  // 'close', the same finish signal as the compatibility response.
  return function emit (eventName) {
    ctx.eventName = eventName
    return emitCh.runStores(ctx, originalEmit, this, ...arguments)
  }
}

function wrapEmit (originalEmit) {
  // Named `emit` mirrors the server method so the one-time wrap skips its name
  // rewrite; rest params keep the per-event forwarding allocation-free.
  return function emit (...args) {
    // A server owned by another instrumentation (e.g. @grpc/grpc-js) drives its
    // own span lifecycle over the raw 'stream' API, so tracing it here would add
    // a spurious web.request span on top of that integration's span and steal
    // the top frame. Skip it entirely; the mark is set at server creation, so
    // this is one property read on servers we do trace.
    if (!startServerCh.hasSubscribers || this[FOREIGN_HTTP2_SERVER]) {
      return Reflect.apply(originalEmit, this, args)
    }

    const eventName = args[0]
    if (eventName === 'stream') {
      // The compatibility layer synthesizes 'request' from an internal 'stream'
      // listener it registers exactly once when a 'request' listener is added,
      // so `listenerCount('stream')` exceeds one only when the application also
      // registered a raw-stream listener. Owning the span here for that case
      // keeps it active while the application's stream listener runs; the
      // synthesized 'request' that fires nested below then reuses it. A
      // request-only server (no raw-stream listener) is left to the 'request'
      // branch so the compatibility response keeps its richer req/res.
      const requestListenerCount = this.listenerCount('request')
      if (requestListenerCount === 0 || this.listenerCount('stream') > 1) {
        const stream = args[1]
        const headers = args[2]
        const ctx = createStreamAdapter(stream, headers)
        // Only a mixed server (a 'request' listener is present) synthesizes a
        // real request off this stream and adopts the span later, so only then
        // does the context need keying on the stream. A raw-stream-only server
        // never adopts; leaving the flag unset keeps the stream->context write
        // off its hot path.
        ctx.adoptable = requestListenerCount !== 0
        tracedStreams.add(stream)

        shimmer.wrap(stream, 'emit', emit => wrapStreamEmit(emit, ctx))
        return traceServerRequest(ctx, () => {
          if (finishSetHeaderCh.hasSubscribers || startWriteHeadCh.hasSubscribers) {
            shimmer.wrap(stream, 'respond', respond => wrapStreamResponse(respond, ctx, 0))
            shimmer.wrap(stream, 'respondWithFD', respond => wrapStreamResponse(respond, ctx, 1))
            shimmer.wrap(stream, 'respondWithFile', respond => wrapStreamResponse(respond, ctx, 1))
            if (startWriteHeadCh.hasSubscribers) {
              shimmer.wrap(stream, 'end', end => wrapStreamEnd(end, ctx))
              shimmer.wrap(stream, 'write', write => wrapStreamWrite(write, ctx))
            }
          }
          return Reflect.apply(originalEmit, this, args)
        })
      }
    } else if (eventName === 'request') {
      const req = args[1]
      const res = args[2]
      res.req = req

      // A mixed server (raw-stream + 'request' listeners) already created the
      // span from the 'stream' event above; the stream's single 'close' is the
      // sole finish source, so skip creating a second span. The synthesized
      // request/response are the real objects a user's 'request' handler and
      // the finish `hooks.request` expect, so hand them to the existing
      // stream-backed context rather than leaving it on the throwaway adapter.
      if (tracedStreams.has(req.stream)) {
        adoptServerCh.publish({ req, res })
      } else {
        const ctx = { req, res }
        shimmer.wrap(res, 'emit', emit => wrapResponseEmit(emit, ctx))
        return traceServerRequest(ctx, () => Reflect.apply(originalEmit, this, args))
      }
    }

    return Reflect.apply(originalEmit, this, args)
  }
}

/**
 * @param {Function} setHeader
 */
function wrapSetHeader (setHeader) {
  return function (...args) {
    if (!startSetHeaderCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers) {
      return Reflect.apply(setHeader, this, args)
    }

    if (startSetHeaderCh.hasSubscribers) {
      const abortController = new AbortController()
      startSetHeaderCh.publish({ res: this, abortController })
      if (abortController.signal.aborted) return
    }

    const result = Reflect.apply(setHeader, this, args)

    if (finishSetHeaderCh.hasSubscribers) {
      finishSetHeaderCh.publish({ name: args[0], value: args[1], res: this })
    }

    return result
  }
}

/**
 * @param {Function} writeHead
 */
function wrapWriteHead (writeHead) {
  return function (...args) {
    if (!startWriteHeadCh.hasSubscribers) {
      return Reflect.apply(writeHead, this, args)
    }

    const abortController = new AbortController()
    const headers = typeof args[1] === 'string' ? args[2] : args[1]
    const responseHeaders = addResponseHeaders(this.getHeaders(), headers)
    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: args[0],
      responseHeaders,
    })
    if (abortController.signal.aborted) return this

    const result = Reflect.apply(writeHead, this, args)

    if (finishSetHeaderCh.hasSubscribers) {
      for (const name of Object.keys(responseHeaders)) {
        finishSetHeaderCh.publish({ name, value: responseHeaders[name], res: this })
      }
    }

    return result
  }
}

/**
 * @param {Function} write
 */
function wrapWrite (write) {
  return function (...args) {
    if (!startWriteHeadCh.hasSubscribers) {
      return Reflect.apply(write, this, args)
    }

    const abortController = new AbortController()
    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders: this.getHeaders(),
    })
    if (abortController.signal.aborted) return true

    return Reflect.apply(write, this, args)
  }
}

/**
 * @param {Function} end
 */
function wrapEnd (end) {
  return function (...args) {
    if (!startWriteHeadCh.hasSubscribers) {
      return Reflect.apply(end, this, args)
    }

    const abortController = new AbortController()
    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders: this.getHeaders(),
    })
    if (abortController.signal.aborted) return this

    return Reflect.apply(end, this, args)
  }
}

/**
 * @param {Function} respond
 * @param {StreamRequestContext} ctx
 * @param {number} headersIndex
 */
function wrapStreamResponse (respond, ctx, headersIndex) {
  return function (...args) {
    const responseHeaders = addResponseHeaders({}, args[headersIndex])
    let abortController
    if (startWriteHeadCh.hasSubscribers) {
      abortController = new AbortController()
      startWriteHeadCh.publish({
        req: ctx.req,
        res: ctx.res,
        abortController,
        statusCode: responseHeaders[HTTP2_HEADER_STATUS] ?? 200,
        responseHeaders,
      })
      if (abortController.signal.aborted) return this
    }

    const result = Reflect.apply(respond, this, args)

    if (finishSetHeaderCh.hasSubscribers) {
      for (const name of Object.keys(responseHeaders)) {
        finishSetHeaderCh.publish({ name, value: responseHeaders[name], res: ctx.res })
      }
    }

    return result
  }
}

/**
 * @param {Function} write
 * @param {StreamRequestContext} ctx
 */
function wrapStreamWrite (write, ctx) {
  return function (...args) {
    if (publishStreamResponse(ctx, this)) return true
    return Reflect.apply(write, this, args)
  }
}

/**
 * @param {Function} end
 * @param {StreamRequestContext} ctx
 */
function wrapStreamEnd (end, ctx) {
  return function (...args) {
    if (publishStreamResponse(ctx, this)) return this
    return Reflect.apply(end, this, args)
  }
}

/**
 * @param {StreamRequestContext} ctx
 * @param {import('node:http2').ServerHttp2Stream} stream
 */
function publishStreamResponse (ctx, stream) {
  const responseHeaders = stream.sentHeaders ?? {}
  const abortController = new AbortController()
  startWriteHeadCh.publish({
    req: ctx.req,
    res: ctx.res,
    abortController,
    statusCode: responseHeaders[HTTP2_HEADER_STATUS] ?? 200,
    responseHeaders,
  })
  return abortController.signal.aborted
}

/**
 * @param {Record<string, unknown>} responseHeaders
 * @param {object | unknown[]} [headers]
 */
function addResponseHeaders (responseHeaders, headers) {
  if (Array.isArray(headers)) {
    const entriesArePairs = Array.isArray(headers[0])
    let addedNames
    if (PRESERVES_DUPLICATE_HEADERS) addedNames = new Set()
    const increment = entriesArePairs ? 1 : 2
    for (let i = 0; i < headers.length; i += increment) {
      const entry = headers[i]
      const name = entriesArePairs ? entry[0] : entry
      const value = entriesArePairs ? entry[1] : headers[i + 1]
      if (addedNames?.has(name)) {
        const previous = responseHeaders[name]
        const values = Array.isArray(previous) ? [...previous] : [previous]
        if (Array.isArray(value)) {
          values.push(...value)
        } else {
          values.push(value)
        }
        responseHeaders[name] = values
      } else {
        responseHeaders[name] = value
        addedNames?.add(name)
      }
    }
  } else if (headers) {
    for (const name of Object.keys(headers)) {
      responseHeaders[name] = headers[name]
    }
  }

  return responseHeaders
}

// Enter the request context and run `emitEvent` (the original `emit`, wrapped to
// publish per-event for the matching response/stream), publishing any synchronous
// throw from a user handler before letting it propagate.
/**
 * @param {StreamRequestContext | { req: object, res: object }} ctx
 * @param {() => unknown} emitEvent
 */
function traceServerRequest (ctx, emitEvent) {
  return startServerCh.runStores(ctx, () => {
    if (ctx.abortController?.signal.aborted) return true

    try {
      return emitEvent()
    } catch (error) {
      ctx.error = error
      errorServerCh.publish(ctx)
      throw error
    }
  })
}

class Http2StreamResponse {
  /** @type {import('node:http2').ServerHttp2Stream} */
  #stream

  /**
   * @param {import('node:http2').ServerHttp2Stream} stream
   * @param {object} req
   */
  constructor (stream, req) {
    this.#stream = stream
    this.req = req
  }

  get headersSent () {
    return this.#stream.headersSent
  }

  get statusCode () {
    return this.#stream.sentHeaders?.[HTTP2_HEADER_STATUS] ?? 200
  }

  /**
   * @param {string} name
   */
  getHeader (name) {
    return this.#stream.sentHeaders?.[name]
  }

  getHeaderNames () {
    return Object.keys(this.#stream.sentHeaders ?? {})
  }

  removeHeader () {}

  /**
   * @param {number} statusCode
   * @param {Record<string, string | string[]>} [headers]
   */
  writeHead (statusCode, headers) {
    this.#stream.respond({
      ...headers,
      [HTTP2_HEADER_STATUS]: statusCode,
    })
    return this
  }

  /**
   * @param {string | Buffer} [body]
   */
  end (body) {
    this.#stream.end(body)
    return this
  }
}

/**
 * The minimal req/res pair the shared web lifecycle (`web.js`) keys on, built
 * from a core-API `Http2Stream`. The fields below are exactly the surface
 * `web.js` / `url.js` / `ip_extractor.js` read for a stream-backed request; a
 * new read added there must be mirrored here or it resolves to `undefined` on
 * the core path only.
 *
 * @typedef {object} StreamRequestContext
 * @property {object} req
 * @property {import('node:http2').ServerHttp2Stream} req.stream branch key in `web.js`/`url.js`
 * @property {import('node:http2').IncomingHttpHeaders} req.headers raw pseudo-header map
 * @property {string} [req.method]
 * @property {string} [req.url]
 * @property {import('node:net').Socket} [req.socket] peer address source (OTel)
 * @property {object} res
 * @property {object} res.req back-reference used by `wrapResponseEmit`/finish
 * @property {number} res.statusCode read at finish from `stream.sentHeaders`
 * @property {(name: string) => string | number | string[] | undefined} res.getHeader response-header tagging
 */

// Present the core-API stream + pseudo-header map as the minimal req/res pair
// the shared web lifecycle (`web.js`) consumes. The response status and headers
// are getters because `stream.sentHeaders` is empty until `stream.respond()`
// runs in the user handler; a snapshot taken here would always be `undefined`.
/**
 * @param {import('node:http2').ServerHttp2Stream} stream
 * @param {import('node:http2').IncomingHttpHeaders} headers
 * @returns {StreamRequestContext}
 */
function createStreamAdapter (stream, headers) {
  const req = {
    stream,
    headers,
    method: headers[HTTP2_HEADER_METHOD],
    url: headers[HTTP2_HEADER_PATH],
    socket: stream.session?.socket,
  }
  const res = new Http2StreamResponse(stream, req)

  return { req, res, isStream: true }
}
