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
// HTTP/2 response types bypass the HTTP prototypes that publish these shared
// AppSec/IAST response-sink channels.
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')
const startSetHeaderCh = channel('datadog:http:server:response:set-header:start')
const startInformationalResponseCh = channel('datadog:http:server:informational-response:start')
const startWriteHeadCh = channel('apm:http:server:response:writeHead:start')

const HTTP2_HEADER_METHOD = ':method'
const HTTP2_HEADER_PATH = ':path'
const HTTP2_HEADER_STATUS = ':status'
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const LOWERCASE_HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/
const ILLEGAL_CONNECTION_HEADERS = new Set([
  'connection',
  'http2-settings',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
])
const SINGLE_VALUE_HEADERS = new Set([
  ':status',
  'access-control-allow-credentials',
  'access-control-max-age',
  'access-control-request-method',
  'age',
  'authorization',
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-md5',
  'content-range',
  'content-type',
  'date',
  'dnt',
  'etag',
  'expires',
  'from',
  'host',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'range',
  'referer',
  'retry-after',
  'tk',
  'upgrade-insecure-requests',
  'user-agent',
  'x-content-type-options',
])
// Node.js started preserving duplicate response header pairs in 20.12.0 and 21.7.0.
const PRESERVES_DUPLICATE_HEADERS = NODE_MAJOR >= 22 ||
  (NODE_MAJOR === 21 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 20 && NODE_MINOR >= 12)
const SUPPORTS_RAW_RESPONSE_HEADERS = NODE_MAJOR >= 25 ||
  (NODE_MAJOR === 24 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 20)

// The compatibility layer emits 'request' from the same stream, so remember
// streams already traced by the mixed-server branch.
const tracedStreams = new WeakSet()
const responseContexts = new WeakMap()
const wrappedStreamPrototypes = new WeakSet()

/** @type {symbol | undefined} */
let sensitiveHeadersSymbol

// Node core methods are not package source Orchestrion can rewrite, so these hooks require shimmer.
addHook({ name: 'http2' }, http2 => {
  sensitiveHeadersSymbol = http2.sensitiveHeaders
  shimmer.wrap(http2, 'createSecureServer', wrapCreateServer)
  shimmer.wrap(http2, 'createServer', wrapCreateServer)

  const responseProto = http2.Http2ServerResponse?.prototype
  if (responseProto) {
    shimmer.wrap(responseProto, 'end', wrapEnd)
    shimmer.wrap(responseProto, 'removeHeader', wrapResponseOperation)
    shimmer.wrap(responseProto, 'setHeader', wrapSetHeader)
    if (responseProto.appendHeader) shimmer.wrap(responseProto, 'appendHeader', wrapSetHeader)
    shimmer.wrap(responseProto, 'write', wrapWrite)
    if (responseProto.writeContinue) shimmer.wrap(responseProto, 'writeContinue', wrapInformationalResponse)
    if (responseProto.writeEarlyHints) shimmer.wrap(responseProto, 'writeEarlyHints', wrapInformationalResponse)
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
          if (finishSetHeaderCh.hasSubscribers ||
            startInformationalResponseCh.hasSubscribers ||
            startWriteHeadCh.hasSubscribers) {
            instrumentStreamResponse(stream, ctx)
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
        const ctx = responseContexts.get(req.stream)
        if (ctx) {
          ctx.res = res
          responseContexts.set(res, ctx)
        }
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
 * @param {Function} responseOperation
 */
function wrapResponseOperation (responseOperation) {
  return function (...args) {
    if (!startSetHeaderCh.hasSubscribers) {
      return Reflect.apply(responseOperation, this, args)
    }

    const abortController = new AbortController()
    startSetHeaderCh.publish({ res: this, abortController })
    if (abortController.signal.aborted) return

    return Reflect.apply(responseOperation, this, args)
  }
}

/**
 * @param {Function} informationalResponse
 */
function wrapInformationalResponse (informationalResponse) {
  return function (...args) {
    if (!startInformationalResponseCh.hasSubscribers) {
      return Reflect.apply(informationalResponse, this, args)
    }

    const abortController = new AbortController()
    startInformationalResponseCh.publish({ res: this, abortController })
    if (abortController.signal.aborted) return

    return Reflect.apply(informationalResponse, this, args)
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
      req: getResponseRequest(this),
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
      req: getResponseRequest(this),
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
      req: getResponseRequest(this),
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
 * @param {import('node:http2').ServerHttp2Stream} stream
 * @param {StreamRequestContext} ctx
 */
function instrumentStreamResponse (stream, ctx) {
  const prototype = Object.getPrototypeOf(stream)
  if (!wrappedStreamPrototypes.has(prototype)) {
    wrappedStreamPrototypes.add(prototype)
    shimmer.wrap(prototype, 'respond', wrapStreamRespond)
    shimmer.wrap(prototype, 'respondWithFD', wrapStreamRespondWithFD)
    shimmer.wrap(prototype, 'respondWithFile', wrapStreamRespondWithFile)
    shimmer.wrap(prototype, 'additionalHeaders', wrapStreamAdditionalHeaders)
    shimmer.wrap(prototype, 'end', wrapStreamEnd)
    shimmer.wrap(prototype, 'write', wrapStreamWrite)
  }
  responseContexts.set(stream, ctx)
}

/**
 * @param {Function} respond
 */
function wrapStreamRespond (respond) {
  return function (...args) {
    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(respond, this, args)
    if (ctx.responseBlocked) return this
    if (this.headersSent || (!startWriteHeadCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers)) {
      return Reflect.apply(respond, this, args)
    }

    if (!hasValidResponseOptions(args[1])) return Reflect.apply(respond, this, args)

    const responseHeaders = getValidatedResponseHeaders(args[0])
    if (!responseHeaders) return Reflect.apply(respond, this, args)

    const responseAllowed = publishStreamResponseStart(ctx, responseHeaders)
    if (!responseAllowed) {
      ctx.responseBlocked = true
      return this
    }

    const result = Reflect.apply(respond, this, args)
    publishStreamResponseFinish(ctx, responseHeaders)
    return result
  }
}

/**
 * @param {Function} respond
 */
function wrapStreamRespondWithFD (respond) {
  return function (...args) {
    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(respond, this, args)
    if (ctx.responseBlocked) return this
    if (this.headersSent || (!startWriteHeadCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers)) {
      return Reflect.apply(respond, this, args)
    }

    const options = args[2]
    if (!hasValidResponseOptions(options, true)) {
      return Reflect.apply(respond, this, args)
    }

    const statCheck = getEnumerableDataProperty(options, 'statCheck')
    if (typeof statCheck === 'function') {
      args[2] = {
        ...options,
        statCheck: wrapStreamStatCheck(statCheck, ctx, this),
      }
      return Reflect.apply(respond, this, args)
    }

    if (typeof args[0] !== 'number') return Reflect.apply(respond, this, args)

    const responseHeaders = getValidatedResponseHeaders(args[1])
    if (!responseHeaders) return Reflect.apply(respond, this, args)

    const statusCode = getResponseStatusCode(responseHeaders)
    if (statusCode === 204 || statusCode === 205 || statusCode === 304 || ctx.req.method === 'HEAD') {
      return Reflect.apply(respond, this, args)
    }

    const responseAllowed = publishStreamResponseStart(ctx, responseHeaders)
    if (!responseAllowed) {
      ctx.responseBlocked = true
      return this
    }

    const result = Reflect.apply(respond, this, args)
    publishStreamResponseFinish(ctx, responseHeaders)
    return result
  }
}

/**
 * @param {Function} respond
 */
function wrapStreamRespondWithFile (respond) {
  return function (...args) {
    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(respond, this, args)
    if (ctx.responseBlocked) return this
    if (this.headersSent || (!startWriteHeadCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers)) {
      return Reflect.apply(respond, this, args)
    }

    const options = args[2]
    if (!hasValidResponseOptions(options, true)) {
      return Reflect.apply(respond, this, args)
    }

    const statCheck = getEnumerableDataProperty(options, 'statCheck')
    args[2] = {
      ...options,
      statCheck: wrapStreamStatCheck(statCheck, ctx, this),
    }
    return Reflect.apply(respond, this, args)
  }
}

/**
 * @param {Function} additionalHeaders
 */
function wrapStreamAdditionalHeaders (additionalHeaders) {
  return function (...args) {
    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(additionalHeaders, this, args)
    if (ctx.responseBlocked) return
    if (!startInformationalResponseCh.hasSubscribers) {
      return Reflect.apply(additionalHeaders, this, args)
    }

    const abortController = new AbortController()
    startInformationalResponseCh.publish({ res: ctx.res, abortController })
    if (abortController.signal.aborted) {
      ctx.responseBlocked = true
      return
    }

    return Reflect.apply(additionalHeaders, this, args)
  }
}

/**
 * @param {Function | undefined} statCheck
 * @param {StreamRequestContext} ctx
 * @param {import('node:http2').ServerHttp2Stream} stream
 */
function wrapStreamStatCheck (statCheck, ctx, stream) {
  return function (...args) {
    const result = statCheck ? Reflect.apply(statCheck, this, args) : true
    if (result === false || stream.headersSent ||
      (!startWriteHeadCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers)) {
      return result
    }

    const responseHeaders = getValidatedResponseHeaders(args[1])
    if (!responseHeaders) return result

    const responseAllowed = publishStreamResponseStart(ctx, responseHeaders)
    if (!responseAllowed) {
      ctx.responseBlocked = true
      return false
    }

    publishStreamResponseFinish(ctx, responseHeaders)
    return result
  }
}

/**
 * @param {Function} write
 */
function wrapStreamWrite (write) {
  return function (...args) {
    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(write, this, args)
    if (ctx.responseBlocked) return true
    if (this.headersSent || !startWriteHeadCh.hasSubscribers) {
      return Reflect.apply(write, this, args)
    }
    if (publishImplicitStreamResponse(ctx, this)) return true
    return Reflect.apply(write, this, args)
  }
}

/**
 * @param {Function} end
 */
function wrapStreamEnd (end) {
  return function (...args) {
    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(end, this, args)
    if (ctx.responseBlocked) return this
    if (this.headersSent || !startWriteHeadCh.hasSubscribers) {
      return Reflect.apply(end, this, args)
    }
    if (publishImplicitStreamResponse(ctx, this)) return this
    return Reflect.apply(end, this, args)
  }
}

/**
 * @param {object | undefined} options
 * @param {boolean} [fileResponse]
 * @returns {boolean}
 */
function hasValidResponseOptions (options, fileResponse = false) {
  if (options === undefined) return true
  if (!hasOnlyDataProperties(options)) return false
  if (!fileResponse) return true

  const offset = getEnumerableDataProperty(options, 'offset')
  const length = getEnumerableDataProperty(options, 'length')
  const statCheck = getEnumerableDataProperty(options, 'statCheck')
  if (offset !== undefined && typeof offset !== 'number') return false
  if (length !== undefined && typeof length !== 'number') return false
  if (statCheck !== undefined && typeof statCheck !== 'function') return false

  return true
}

/**
 * @param {object | undefined} value
 * @param {string} name
 */
function getEnumerableDataProperty (value, name) {
  if (value === undefined) return
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor?.enumerable && Object.hasOwn(descriptor, 'value')) return descriptor.value
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasOnlyDataProperties (value) {
  if (value === null || typeof value !== 'object') return false

  for (const name of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
  }

  return true
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isStableHeaderValue (value) {
  if (!Array.isArray(value)) {
    return value === null || value === undefined ||
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  }

  for (const item of value) {
    if (item !== null && item !== undefined &&
      typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      return false
    }
  }
  return true
}

/**
 * @param {Record<string, unknown>} responseHeaders
 * @returns {number | undefined}
 */
function getResponseStatusCode (responseHeaders) {
  const value = responseHeaders[HTTP2_HEADER_STATUS]
  if (value !== null && value !== undefined &&
    typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return
  }

  const statusCode = value | 0 || 200
  if (statusCode >= 200 && statusCode <= 599) return statusCode
}

/**
 * @param {unknown} headers
 * @returns {Record<string, unknown> | undefined}
 */
function getValidatedResponseHeaders (headers) {
  if (headers === undefined) return {}

  let responseHeaders
  let responseHeaderNames
  let canReturnFast = true
  let isValid = true
  let requiresNormalization = false

  if (headers === null || typeof headers !== 'object') return

  const headersAreRaw = Array.isArray(headers)
  if (headersAreRaw) {
    if (!SUPPORTS_RAW_RESPONSE_HEADERS ||
      headers.length % 2 !== 0 ||
      headers.unshift !== Array.prototype.unshift ||
      headers.push !== Array.prototype.push ||
      !Object.isExtensible(headers) ||
      !Object.getOwnPropertyDescriptor(headers, 'length')?.writable) {
      return
    }
    for (let i = 0; i < headers.length; i += 2) {
      if (typeof headers[i] !== 'string') return
    }
  } else {
    responseHeaders = {}
    responseHeaderNames = Object.keys(headers)
    for (const rawName of responseHeaderNames) {
      const value = headers[rawName]
      if (rawName === '__proto__') {
        Object.defineProperty(responseHeaders, rawName, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        })
      } else {
        responseHeaders[rawName] = value
      }
      if (value === undefined || rawName === '' || (Array.isArray(value) && value.length === 0)) {
        canReturnFast = false
        if (rawName !== rawName.toLowerCase()) requiresNormalization = true
      } else {
        const headerIsValid = isValidResponseHeader(rawName, value, LOWERCASE_HTTP_HEADER_NAME_PATTERN)
        if (!headerIsValid) {
          if (rawName === rawName.toLowerCase()) {
            isValid = false
          } else {
            requiresNormalization = true
          }
        }
      }
    }
  }

  const sensitiveHeaders = sensitiveHeadersSymbol && headers[sensitiveHeadersSymbol]
  if (sensitiveHeaders !== undefined) {
    if (!Array.isArray(sensitiveHeaders)) return
    for (const name of sensitiveHeaders) {
      if (typeof name !== 'string') return
    }
  }

  if (requiresNormalization) {
    responseHeaders = addResponseHeaders({ __proto__: null }, responseHeaders, true)
    responseHeaderNames = Object.keys(responseHeaders)
  } else if (responseHeaders && canReturnFast) {
    if (!isValid || getResponseStatusCode(responseHeaders) === undefined) return
    return responseHeaders
  }

  if (!responseHeaders) {
    responseHeaders = addResponseHeaders({ __proto__: null }, headers, true)
    responseHeaderNames = Object.keys(responseHeaders)
  }

  return validateResponseHeaders(responseHeaders, responseHeaderNames)
}

/**
 * @param {Record<string, unknown>} responseHeaders
 * @param {string[]} responseHeaderNames
 * @returns {Record<string, unknown> | undefined}
 */
function validateResponseHeaders (responseHeaders, responseHeaderNames) {
  if (getResponseStatusCode(responseHeaders) === undefined) return

  for (const name of responseHeaderNames) {
    const value = responseHeaders[name]
    if (value === undefined || name === '' || (Array.isArray(value) && value.length === 0)) {
      delete responseHeaders[name]
      continue
    }
    if (!isValidResponseHeader(name, value, HTTP_HEADER_NAME_PATTERN)) return
  }

  return responseHeaders
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {RegExp} namePattern
 * @returns {boolean}
 */
function isValidResponseHeader (name, value, namePattern) {
  if (!isStableHeaderValue(value)) return false
  if (name[0] === ':') return name === HTTP2_HEADER_STATUS
  if (!namePattern.test(name) || ILLEGAL_CONNECTION_HEADERS.has(name)) return false
  if (Array.isArray(value) && value.length > 1 && SINGLE_VALUE_HEADERS.has(name)) return false

  const normalizedValue = Array.isArray(value) ? value[0] : value
  return name !== 'te' || normalizedValue === 'trailers'
}

/**
 * @param {StreamRequestContext} ctx
 * @param {Record<string, unknown>} responseHeaders
 * @returns {boolean}
 */
function publishStreamResponseStart (ctx, responseHeaders) {
  if (!startWriteHeadCh.hasSubscribers) return true

  const abortController = new AbortController()
  startWriteHeadCh.publish({
    req: ctx.req,
    res: ctx.res,
    abortController,
    statusCode: responseHeaders[HTTP2_HEADER_STATUS] ?? 200,
    responseHeaders,
  })
  return !abortController.signal.aborted
}

/**
 * @param {StreamRequestContext} ctx
 * @param {Record<string, unknown>} responseHeaders
 */
function publishStreamResponseFinish (ctx, responseHeaders) {
  if (!finishSetHeaderCh.hasSubscribers) return

  for (const name of Object.keys(responseHeaders)) {
    finishSetHeaderCh.publish({ name, value: responseHeaders[name], res: ctx.res })
  }
}

/**
 * @param {StreamRequestContext} ctx
 * @param {import('node:http2').ServerHttp2Stream} stream
 * @returns {boolean}
 */
function publishImplicitStreamResponse (ctx, stream) {
  const responseHeaders = addResponseHeaders({}, stream.sentHeaders, true)
  const abortController = new AbortController()
  startWriteHeadCh.publish({
    req: ctx.req,
    res: ctx.res,
    abortController,
    statusCode: responseHeaders[HTTP2_HEADER_STATUS] ?? 200,
    responseHeaders,
  })
  if (!abortController.signal.aborted) return false

  ctx.responseBlocked = true
  return true
}

/**
 * @param {import('node:http2').Http2ServerResponse} res
 */
function getResponseRequest (res) {
  return responseContexts.get(res)?.req ?? res.req
}

/**
 * @param {Record<string, unknown>} responseHeaders
 * @param {object | unknown[]} [headers]
 * @param {boolean} [preserveDuplicates]
 */
function addResponseHeaders (responseHeaders, headers, preserveDuplicates = false) {
  if (Array.isArray(headers)) {
    const entriesArePairs = Array.isArray(headers[0])
    let addedNames
    if (preserveDuplicates || PRESERVES_DUPLICATE_HEADERS) addedNames = new Set()
    const increment = entriesArePairs ? 1 : 2
    for (let i = 0; i < headers.length; i += increment) {
      const entry = headers[i]
      const rawName = entriesArePairs ? entry[0] : entry
      const name = rawName.toLowerCase()
      const value = entriesArePairs ? entry[1] : headers[i + 1]
      addResponseHeader(responseHeaders, name, value, addedNames)
    }
  } else if (headers) {
    let addedNames
    if (preserveDuplicates) addedNames = new Set()
    for (const rawName of Object.keys(headers)) {
      const name = rawName.toLowerCase()
      const value = headers[rawName]
      addResponseHeader(responseHeaders, name, value, addedNames)
    }
  }

  return responseHeaders
}

/**
 * @param {Record<string, unknown>} responseHeaders
 * @param {string} name
 * @param {unknown} value
 * @param {Set<string> | undefined} addedNames
 */
function addResponseHeader (responseHeaders, name, value, addedNames) {
  if (!addedNames?.has(name)) {
    responseHeaders[name] = value
    addedNames?.add(name)
    return
  }

  const previous = responseHeaders[name]
  const values = Array.isArray(previous) ? [...previous] : [previous]
  if (Array.isArray(value)) {
    values.push(...value)
  } else {
    values.push(value)
  }
  responseHeaders[name] = values
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
  /**
   * @type {import('node:http2').ServerHttp2Stream}
   */
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

  /**
   * @returns {string[]}
   */
  getHeaderNames () {
    return []
  }

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
 * @property {boolean} [responseBlocked] subsequent response operations are suppressed after blocking
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
