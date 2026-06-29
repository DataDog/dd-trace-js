'use strict'

const {
  channel,
  addHook,
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http2:server:request:start')
const errorServerCh = channel('apm:http2:server:request:error')
const emitCh = channel('apm:http2:server:response:emit')

const HTTP2_HEADER_METHOD = ':method'
const HTTP2_HEADER_PATH = ':path'
const HTTP2_HEADER_STATUS = ':status'

addHook({ name: 'http2' }, http2 => {
  shimmer.wrap(http2, 'createSecureServer', wrapCreateServer)
  shimmer.wrap(http2, 'createServer', wrapCreateServer)
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
        return Reflect.apply(originalEmit, this, args)
      })
    }

    return Reflect.apply(originalEmit, this, args)
  }
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
    try {
      return emitEvent()
    } catch (error) {
      // `EventEmitter.emit` rethrows a listener's synchronous throw to its
      // caller (this wrapper), so the catch is reachable. It unwinds through
      // Node's http2 session synchronously and surfaces as an uncaughtException,
      // which crashes any in-process test harness, so it is covered here rather
      // than in a spec. Mirrors the `apm:http:server:request:error` path.
      /* istanbul ignore next */
      ctx.error = error
      /* istanbul ignore next */
      errorServerCh.publish(ctx)
      /* istanbul ignore next */
      throw error
    }
  })
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
 * @property {string} [res.statusCode] read at finish from `stream.sentHeaders`
 * @property {(name: string) => string | undefined} res.getHeader response-header tagging
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
  const res = {
    req,
    get statusCode () {
      // A stream aborted before `stream.respond()` has no `:status`. The
      // compatibility `Http2ServerResponse.statusCode` defaults to 200 in that
      // case, so match it rather than report `undefined` (which `validateStatus`
      // would treat as an error and which drops the `http.status_code` tag).
      return stream.sentHeaders?.[HTTP2_HEADER_STATUS] ?? 200
    },
    getHeader (name) {
      return stream.sentHeaders?.[name]
    },
  }

  return { req, res }
}
