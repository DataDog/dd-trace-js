'use strict'

const {
  channel,
  addHook,
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http2:server:request:start')
const errorServerCh = channel('apm:http2:server:request:error')
const emitCh = channel('apm:http2:server:response:emit')
// Reuse the `http` response-sink channels so the existing AppSec/IAST analyzers
// fire for HTTP/2 too. `Http2ServerResponse` and `Http2Stream` do not share the
// `http.ServerResponse` prototype the `http` instrumentation wraps, so without
// these republications every response-side sink is dead for both HTTP/2 APIs.
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')
const startWriteHeadCh = channel('apm:http:server:response:writeHead:start')

const HTTP2_HEADER_METHOD = ':method'
const HTTP2_HEADER_PATH = ':path'
const HTTP2_HEADER_STATUS = ':status'

addHook({ name: 'http2' }, http2 => {
  shimmer.wrap(http2, 'createSecureServer', wrapCreateServer)
  shimmer.wrap(http2, 'createServer', wrapCreateServer)

  const responseProto = http2.Http2ServerResponse?.prototype
  if (responseProto) {
    shimmer.wrap(responseProto, 'setHeader', wrapSetHeader)
    shimmer.wrap(responseProto, 'appendHeader', wrapSetHeader)
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
    if (!startServerCh.hasSubscribers) {
      return Reflect.apply(originalEmit, this, args)
    }

    const eventName = args[0]
    if (eventName === 'request') {
      const req = args[1]
      const res = args[2]
      res.req = req

      const ctx = { req, res }
      return traceServerRequest(ctx, () => {
        shimmer.wrap(res, 'emit', emit => wrapResponseEmit(emit, ctx))
        return Reflect.apply(originalEmit, this, args)
      })
    }

    // Core API: a compatibility server emits both 'request' and 'stream' for
    // every request, so the span belongs to the 'request' branch above when a
    // 'request' listener exists. Only a server without one is using the raw
    // stream API, where this branch is the sole place a server span is created.
    if (eventName === 'stream' && this.listenerCount('request') === 0) {
      const stream = args[1]
      const headers = args[2]
      const ctx = createStreamAdapter(stream, headers)

      return traceServerRequest(ctx, () => {
        shimmer.wrap(stream, 'emit', emit => wrapStreamEmit(emit, ctx))
        shimmer.wrap(stream, 'respond', respond => function (...args) {
          publishStreamResponse(ctx, args[0])
          return Reflect.apply(respond, this, args)
        })
        return Reflect.apply(originalEmit, this, args)
      })
    }

    return Reflect.apply(originalEmit, this, args)
  }
}

// Compatibility response: republish each header set on the response so the
// redirect / set-cookie analyzers (keyed on the `http` set-header channel) run.
function wrapSetHeader (setHeader) {
  return function (...args) {
    const result = Reflect.apply(setHeader, this, args)

    if (finishSetHeaderCh.hasSubscribers) {
      finishSetHeaderCh.publish({ name: args[0], value: args[1], res: this })
    }

    return result
  }
}

// Compatibility response: republish the response status + header map so the
// missing-security-header analyzers and response-header collection run.
function wrapWriteHead (writeHead) {
  return function (...args) {
    if (startWriteHeadCh.hasSubscribers) {
      startWriteHeadCh.publish({
        req: this.req,
        res: this,
        statusCode: args[0],
        responseHeaders: this.getHeaders(),
      })
    }

    return Reflect.apply(writeHead, this, args)
  }
}

// Core stream: `respond(headers)` is the single point that sets every response
// header, so publish the same response-sink channels the compatibility response
// does, driving the same analyzers without a `ServerResponse`.
function publishStreamResponse (ctx, headers) {
  if (!headers) return

  if (finishSetHeaderCh.hasSubscribers) {
    for (const name of Object.keys(headers)) {
      finishSetHeaderCh.publish({ name, value: headers[name], res: ctx.res })
    }
  }

  if (startWriteHeadCh.hasSubscribers) {
    startWriteHeadCh.publish({
      req: ctx.req,
      res: ctx.res,
      statusCode: headers[HTTP2_HEADER_STATUS],
      responseHeaders: headers,
    })
  }
}

// Enter the request context and run `emitEvent` (the original `emit`, wrapped to
// publish per-event for the matching response/stream), publishing any synchronous
// throw from a user handler before letting it propagate.
function traceServerRequest (ctx, emitEvent) {
  return startServerCh.runStores(ctx, () => {
    try {
      return emitEvent()
    } catch (error) {
      // Reached when a user request/stream handler throws synchronously; publish
      // the error onto the span, then re-throw to preserve Node's native behavior
      // of surfacing it to the caller of `emit`. Node turns a throwing handler
      // into an uncaughtException, so this is not exercised under test.
      /* istanbul ignore next */
      ctx.error = error
      /* istanbul ignore next */
      errorServerCh.publish(ctx)
      /* istanbul ignore next */
      throw error
    }
  })
}

// Present the core-API stream + pseudo-header map as the minimal req/res pair
// the shared web lifecycle (`web.js`) consumes. `req.stream` is the field its
// URL/context branches key on; the response status and headers live on the
// stream's `sentHeaders`, populated by `stream.respond()`.
function createStreamAdapter (stream, headers) {
  const req = {
    stream,
    headers,
    method: headers[HTTP2_HEADER_METHOD],
    url: headers[HTTP2_HEADER_PATH],
    socket: stream.session?.socket,
  }
  const res = {
    req,
    get statusCode () {
      return stream.sentHeaders?.[HTTP2_HEADER_STATUS]
    },
    getHeader (name) {
      return stream.sentHeaders?.[name]
    },
  }

  return { req, res }
}
