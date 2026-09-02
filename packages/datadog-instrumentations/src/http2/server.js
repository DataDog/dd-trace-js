'use strict'

const { isProxy } = require('node:util/types')

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
const SUPPORTS_RAW_RESPONSE_HEADERS = NODE_MAJOR >= 25 ||
  (NODE_MAJOR === 24 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 20)
const SUPPORTS_RELAXED_SINGLE_VALUE_FIELDS = NODE_MAJOR >= 26 ||
  (NODE_MAJOR === 25 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 24 && NODE_MINOR >= 15)

const responseContexts = new WeakMap()
const wrappedStreamPrototypes = new WeakSet()
let activeBlockedStreamCount = 0

const FILE_HANDLE_VALIDATION_ERROR = {}
const FILE_HANDLE_VALIDATION_HEADERS = {
  get validation () { throw FILE_HANDLE_VALIDATION_ERROR },
}

/** @typedef {{ length: number, [index: number]: unknown } & Iterable<unknown>} ArgumentsLike */

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
    shimmer.wrap(responseProto, 'writeHead', wrapWriteHead)
  }

  return http2
})

function wrapCreateServer (createServer) {
  return function (...args) {
    let strictSingleValueFields = true
    if (SUPPORTS_RELAXED_SINGLE_VALUE_FIELDS && args[0] !== null && typeof args[0] === 'object') {
      args[0] = { ...args[0] }
      strictSingleValueFields = args[0].strictSingleValueFields !== false
    }
    const server = createServer.apply(this, args)
    shimmer.wrap(server, 'emit', emit => wrapEmit(emit, strictSingleValueFields))
    return server
  }
}

function wrapResponseEmit (originalEmit, ctx) {
  // Named `emit`/arity-1 mirrors the response method so the per-response wrap
  // skips its name/length rewrite.
  return function emit (eventName) {
    ctx.req = this.req
    ctx.eventName = eventName
    if (eventName !== 'close') {
      return emitCh.runStores(ctx, originalEmit, this, ...arguments)
    }

    try {
      return emitCh.runStores(ctx, originalEmit, this, ...arguments)
    } finally {
      closeStreamResponse(ctx)
    }
  }
}

function wrapStreamEmit (originalEmit, ctx) {
  // Named `emit`/arity-1 mirrors the stream method so the per-stream wrap skips
  // its name/length rewrite. `this` is the Http2Stream; the plugin finishes on
  // 'close', the same finish signal as the compatibility response.
  return function emit (eventName) {
    ctx.eventName = eventName
    if (eventName !== 'close') {
      return emitCh.runStores(ctx, originalEmit, this, ...arguments)
    }

    try {
      return emitCh.runStores(ctx, originalEmit, this, ...arguments)
    } finally {
      closeStreamResponse(ctx)
    }
  }
}

/**
 * @param {StreamRequestContext} ctx
 */
function closeStreamResponse (ctx) {
  if (ctx.responseClosed) return

  ctx.responseClosed = true
  if (!ctx.responseBlocked) return
  activeBlockedStreamCount--
}

function wrapEmit (originalEmit, strictSingleValueFields) {
  // Named `emit` mirrors the server method so the one-time wrap skips its name
  // rewrite.
  return function emit () {
    // A server owned by another instrumentation (e.g. @grpc/grpc-js) drives its
    // own span lifecycle over the raw 'stream' API, so tracing it here would add
    // a spurious web.request span on top of that integration's span and steal
    // the top frame. Skip it entirely; the mark is set at server creation, so
    // this is one property read on servers we do trace.
    if (!startServerCh.hasSubscribers || this[FOREIGN_HTTP2_SERVER]) {
      return Reflect.apply(originalEmit, this, arguments)
    }

    const eventName = arguments[0]
    if (eventName === 'stream') {
      // Own mixed raw/compatibility requests and compatibility responses that
      // can start before 'request' at the stream boundary. Their nested
      // compatibility event adopts the real request and response.
      const requestListenerCount = this.listenerCount('request')
      const headers = arguments[2]
      const requiresStreamContext = headers[HTTP2_HEADER_METHOD] === 'CONNECT' || headers.expect !== undefined
      if (requestListenerCount === 0 || this.listenerCount('stream') > 1 || requiresStreamContext) {
        const stream = arguments[1]
        const ctx = createStreamAdapter(stream, headers, strictSingleValueFields)
        ctx.adoptable = requestListenerCount !== 0 || requiresStreamContext

        shimmer.wrap(stream, 'emit', emit => wrapStreamEmit(emit, ctx))
        return traceServerRequest(ctx, () => {
          // Response subscribers can be added after this event, so keep the context for the stream lifetime.
          instrumentStreamResponse(stream, ctx)
          return Reflect.apply(originalEmit, this, arguments)
        })
      }
    } else if (eventName === 'request' || eventName === 'connect' ||
      eventName === 'checkContinue' || eventName === 'checkExpectation') {
      const req = arguments[1]
      const stream = req?.stream
      if (!stream && eventName !== 'request') return Reflect.apply(originalEmit, this, arguments)

      const res = arguments[2]
      res.req = req

      if (!stream) {
        const ctx = { req, res }
        shimmer.wrap(res, 'emit', emit => wrapResponseEmit(emit, ctx))
        return traceServerRequest(ctx, () => Reflect.apply(originalEmit, this, arguments))
      }

      // A stream-backed request already owns the span and its single finish
      // source. Adopt the compatibility objects instead of creating another.
      const streamContext = responseContexts.get(stream)
      if (streamContext) {
        streamContext.res = res
        adoptServerCh.publish({ req, res })
      } else {
        const ctx = { req, res }
        if (!strictSingleValueFields) ctx.strictSingleValueFields = false
        shimmer.wrap(res, 'emit', emit => wrapResponseEmit(emit, ctx))
        return traceServerRequest(ctx, () => {
          instrumentStreamResponse(stream, ctx)
          return Reflect.apply(originalEmit, this, arguments)
        })
      }
    }

    return Reflect.apply(originalEmit, this, arguments)
  }
}

/**
 * @param {Function} setHeader
 */
function wrapSetHeader (setHeader) {
  return function () {
    if (!startSetHeaderCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers) {
      return Reflect.apply(setHeader, this, arguments)
    }

    if (startSetHeaderCh.hasSubscribers) {
      const abortController = new AbortController()
      startSetHeaderCh.publish({ res: this, abortController })
      if (abortController.signal.aborted) return
    }

    const result = Reflect.apply(setHeader, this, arguments)

    if (finishSetHeaderCh.hasSubscribers) {
      finishSetHeaderCh.publish({ name: arguments[0], value: arguments[1], res: this })
    }

    return result
  }
}

/**
 * @param {Function} responseOperation
 */
function wrapResponseOperation (responseOperation) {
  return function () {
    if (!startSetHeaderCh.hasSubscribers) {
      return Reflect.apply(responseOperation, this, arguments)
    }

    const abortController = new AbortController()
    startSetHeaderCh.publish({ res: this, abortController })
    if (abortController.signal.aborted) return

    return Reflect.apply(responseOperation, this, arguments)
  }
}

/**
 * @param {Function} writeHead
 */
function wrapWriteHead (writeHead) {
  return function () {
    if (!startSetHeaderCh.hasSubscribers) return Reflect.apply(writeHead, this, arguments)
    if (responseOperationIsBlocked(this)) return this
    return Reflect.apply(writeHead, this, arguments)
  }
}

/**
 * @param {Function} write
 */
function wrapWrite (write) {
  return function () {
    if (!startSetHeaderCh.hasSubscribers) return Reflect.apply(write, this, arguments)
    if (responseOperationIsBlocked(this)) return true
    return Reflect.apply(write, this, arguments)
  }
}

/**
 * @param {Function} end
 */
function wrapEnd (end) {
  return function () {
    if (!startSetHeaderCh.hasSubscribers) return Reflect.apply(end, this, arguments)
    if (responseOperationIsBlocked(this)) return this
    return Reflect.apply(end, this, arguments)
  }
}

/**
 * @param {import('node:http2').Http2ServerResponse} res
 * @returns {boolean}
 */
function responseOperationIsBlocked (res) {
  const abortController = new AbortController()
  startSetHeaderCh.publish({ res, abortController })
  return abortController.signal.aborted
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
  return function () {
    const hasSubscribers = startWriteHeadCh.hasSubscribers || finishSetHeaderCh.hasSubscribers
    if (!hasSubscribers && activeBlockedStreamCount === 0) {
      return Reflect.apply(respond, this, arguments)
    }

    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(respond, this, arguments)
    if (ctx.responseBlocked) return this
    if (this.destroyed || this.closed || this.headersSent || !hasSubscribers) {
      return Reflect.apply(respond, this, arguments)
    }

    const options = copyResponseOptions(arguments, 1)
    if (!hasValidResponseOptions(options)) return Reflect.apply(respond, this, arguments)

    const responseHeaders = getValidatedResponseHeaders(arguments[0], arguments, 0, ctx.strictSingleValueFields)
    if (!responseHeaders) return Reflect.apply(respond, this, arguments)

    const responseAllowed = publishStreamResponseStart(ctx, responseHeaders)
    if (!responseAllowed) {
      markStreamResponseBlocked(ctx)
      return this
    }

    const result = Reflect.apply(respond, this, arguments)
    publishStreamResponseFinish(ctx, responseHeaders)
    return result
  }
}

/**
 * @param {Function} respond
 */
function wrapStreamRespondWithFD (respond) {
  return function () {
    const hasSubscribers = startWriteHeadCh.hasSubscribers || finishSetHeaderCh.hasSubscribers
    if (!hasSubscribers && activeBlockedStreamCount === 0) {
      return Reflect.apply(respond, this, arguments)
    }

    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(respond, this, arguments)
    if (ctx.responseBlocked) return this
    if (this.destroyed || this.closed || this.headersSent || !hasSubscribers) {
      return Reflect.apply(respond, this, arguments)
    }

    const options = copyResponseOptions(arguments, 2)
    if (!hasValidResponseOptions(options, true)) {
      return Reflect.apply(respond, this, arguments)
    }

    const statCheck = getEnumerableDataProperty(options, 'statCheck')
    if (typeof statCheck === 'function') {
      const args = [...arguments]
      args[2] = {
        ...options,
        statCheck: wrapStreamStatCheck(statCheck, ctx, this),
      }
      return Reflect.apply(respond, this, args)
    }
    if (typeof arguments[0] !== 'number') assertFileHandle(respond, this, arguments[0])

    const responseHeaders = getValidatedResponseHeaders(arguments[1], arguments, 1, ctx.strictSingleValueFields)
    if (!responseHeaders) return Reflect.apply(respond, this, arguments)

    const statusCode = getResponseStatusCode(responseHeaders)
    if (statusCode === 204 || statusCode === 205 || statusCode === 304 || ctx.req.method === 'HEAD') {
      return Reflect.apply(respond, this, arguments)
    }

    const responseAllowed = publishStreamResponseStart(ctx, responseHeaders)
    if (!responseAllowed) {
      markStreamResponseBlocked(ctx)
      return this
    }

    const result = Reflect.apply(respond, this, arguments)
    publishStreamResponseFinish(ctx, responseHeaders)
    return result
  }
}

/**
 * @param {Function} respond
 * @param {import('node:http2').ServerHttp2Stream} stream
 * @param {unknown} fileHandle
 */
function assertFileHandle (respond, stream, fileHandle) {
  // Node checks the FileHandle brand before it reads response headers. Re-enter
  // with a throwing header to reuse that exact check without sending a response.
  try {
    Reflect.apply(respond, stream, [fileHandle, FILE_HANDLE_VALIDATION_HEADERS])
  } catch (error) {
    if (error === FILE_HANDLE_VALIDATION_ERROR) return
    throw error
  }
}

/**
 * @param {Function} respond
 */
function wrapStreamRespondWithFile (respond) {
  return function () {
    const hasSubscribers = startWriteHeadCh.hasSubscribers || finishSetHeaderCh.hasSubscribers
    if (!hasSubscribers && activeBlockedStreamCount === 0) {
      return Reflect.apply(respond, this, arguments)
    }

    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(respond, this, arguments)
    if (ctx.responseBlocked) return this
    if (this.destroyed || this.closed || this.headersSent || !hasSubscribers) {
      return Reflect.apply(respond, this, arguments)
    }

    const options = copyResponseOptions(arguments, 2)
    if (!hasValidResponseOptions(options, true)) {
      return Reflect.apply(respond, this, arguments)
    }

    const statCheck = getEnumerableDataProperty(options, 'statCheck')
    const args = [...arguments]
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
  return function () {
    const hasSubscribers = startInformationalResponseCh.hasSubscribers
    if (!hasSubscribers && activeBlockedStreamCount === 0) {
      return Reflect.apply(additionalHeaders, this, arguments)
    }

    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(additionalHeaders, this, arguments)
    if (ctx.responseBlocked) return
    if (this.destroyed || this.closed || this.headersSent || !hasSubscribers) {
      return Reflect.apply(additionalHeaders, this, arguments)
    }

    const abortController = new AbortController()
    startInformationalResponseCh.publish({ res: ctx.res, abortController })
    if (abortController.signal.aborted) {
      markStreamResponseBlocked(ctx)
      return
    }

    return Reflect.apply(additionalHeaders, this, arguments)
  }
}

/**
 * @param {Function | undefined} statCheck
 * @param {StreamRequestContext} ctx
 * @param {import('node:http2').ServerHttp2Stream} stream
 */
function wrapStreamStatCheck (statCheck, ctx, stream) {
  return function () {
    const result = statCheck ? Reflect.apply(statCheck, this, arguments) : true
    if (result === false || stream.destroyed || stream.closed || stream.headersSent ||
      (!startWriteHeadCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers)) {
      return result
    }

    const responseHeaders = getValidatedResponseHeaders(arguments[1], undefined, 0, ctx.strictSingleValueFields)
    if (!responseHeaders) return result

    const responseAllowed = publishStreamResponseStart(ctx, responseHeaders)
    if (!responseAllowed) {
      markStreamResponseBlocked(ctx)
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
  return function () {
    const hasSubscribers = startWriteHeadCh.hasSubscribers
    if (!hasSubscribers && activeBlockedStreamCount === 0) {
      return Reflect.apply(write, this, arguments)
    }

    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(write, this, arguments)
    if (ctx.responseBlocked) return true
    if (this.destroyed || this.closed || this.headersSent || !hasSubscribers) {
      return Reflect.apply(write, this, arguments)
    }
    if (publishImplicitStreamResponse(ctx, this)) return true
    return Reflect.apply(write, this, arguments)
  }
}

/**
 * @param {Function} end
 */
function wrapStreamEnd (end) {
  return function () {
    const hasSubscribers = startWriteHeadCh.hasSubscribers
    if (!hasSubscribers && activeBlockedStreamCount === 0) {
      return Reflect.apply(end, this, arguments)
    }

    const ctx = responseContexts.get(this)
    if (!ctx) return Reflect.apply(end, this, arguments)
    if (ctx.responseBlocked) return this
    if (this.destroyed || this.closed || this.headersSent || !hasSubscribers) {
      return Reflect.apply(end, this, arguments)
    }
    if (publishImplicitStreamResponse(ctx, this)) return this
    return Reflect.apply(end, this, arguments)
  }
}

/**
 * @param {ArgumentsLike} args
 * @param {number} index
 * @returns {unknown}
 */
function copyResponseOptions (args, index) {
  const options = args[index]
  if (options !== null && typeof options === 'object' && !Array.isArray(options)) {
    const copy = { ...options }
    args[index] = copy
    return copy
  }
  return options
}

/**
 * @param {unknown} options
 * @param {boolean} [fileResponse]
 * @returns {boolean}
 */
function hasValidResponseOptions (options, fileResponse = false) {
  if (options === undefined) return true
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return false
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
function isStableHeaderValue (value) {
  if (!Array.isArray(value)) {
    return value === null || value === undefined ||
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  }

  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
    const item = descriptor.value
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
 * @param {ArgumentsLike} [argumentsObject]
 * @param {number} [headerIndex]
 * @param {boolean} [strictSingleValueFields]
 * @returns {Record<string, unknown> | undefined}
 */
function getValidatedResponseHeaders (headers, argumentsObject, headerIndex = 0, strictSingleValueFields = true) {
  if (headers === undefined) return {}

  let responseHeaders
  let forwardedHeaders
  let responseHeaderNames
  let canReturnFast = true
  let isValid = true
  let requiresNormalization = false

  if (headers === null || typeof headers !== 'object') return

  const headersAreRaw = Array.isArray(headers)
  if (headersAreRaw) {
    if (!SUPPORTS_RAW_RESPONSE_HEADERS ||
      isProxy(headers) ||
      headers.length % 2 !== 0 ||
      headers.unshift !== Array.prototype.unshift ||
      headers.push !== Array.prototype.push ||
      !Object.isExtensible(headers) ||
      !Object.getOwnPropertyDescriptor(headers, 'length')?.writable) {
      return
    }
    for (let i = 0; i < headers.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(headers, String(i))
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return
      if (i % 2 === 0 && typeof descriptor.value !== 'string') return
    }
  } else {
    responseHeaders = {}
    forwardedHeaders = responseHeaders
    responseHeaderNames = Object.keys(headers)
    for (const rawName of responseHeaderNames) {
      let value
      if (argumentsObject) {
        value = headers[rawName]
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(headers, rawName)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return
        value = descriptor.value
      }
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
        const headerIsValid = isValidResponseHeader(
          rawName,
          value,
          LOWERCASE_HTTP_HEADER_NAME_PATTERN,
          strictSingleValueFields
        )
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

  let sensitiveHeaders
  if (sensitiveHeadersSymbol) {
    const descriptor = Object.getOwnPropertyDescriptor(headers, sensitiveHeadersSymbol)
    if (headersAreRaw) {
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return
      sensitiveHeaders = descriptor?.value
    } else {
      sensitiveHeaders = headers[sensitiveHeadersSymbol]
    }
  }
  if (forwardedHeaders) {
    if (sensitiveHeaders !== undefined) forwardedHeaders[sensitiveHeadersSymbol] = sensitiveHeaders
    if (argumentsObject) argumentsObject[headerIndex] = forwardedHeaders
  }
  if (sensitiveHeaders !== undefined) {
    if (!Array.isArray(sensitiveHeaders) || sensitiveHeaders.map !== Array.prototype.map) return
    for (let i = 0; i < sensitiveHeaders.length; i++) {
      const name = sensitiveHeaders[i]
      if (typeof name !== 'string') return
    }
  }

  let validatedResponseHeaders
  if (requiresNormalization) {
    responseHeaders = addResponseHeaders({ __proto__: null }, responseHeaders)
    responseHeaderNames = Object.keys(responseHeaders)
  } else if (responseHeaders && canReturnFast) {
    if (!isValid || getResponseStatusCode(responseHeaders) === undefined) return
    validatedResponseHeaders = responseHeaders
  }

  if (!validatedResponseHeaders) {
    if (!responseHeaders) {
      responseHeaders = addResponseHeaders({ __proto__: null }, headers)
      responseHeaderNames = Object.keys(responseHeaders)
    }
    validatedResponseHeaders = validateResponseHeaders(responseHeaders, responseHeaderNames, strictSingleValueFields)
  }

  if (validatedResponseHeaders && validatedResponseHeaders !== forwardedHeaders && sensitiveHeaders !== undefined) {
    validatedResponseHeaders[sensitiveHeadersSymbol] = sensitiveHeaders
  }
  return validatedResponseHeaders
}

/**
 * @param {Record<string, unknown>} responseHeaders
 * @param {string[]} responseHeaderNames
 * @param {boolean} strictSingleValueFields
 * @returns {Record<string, unknown> | undefined}
 */
function validateResponseHeaders (responseHeaders, responseHeaderNames, strictSingleValueFields) {
  if (getResponseStatusCode(responseHeaders) === undefined) return

  for (const name of responseHeaderNames) {
    const value = responseHeaders[name]
    if (value === undefined || name === '' || (Array.isArray(value) && value.length === 0)) {
      delete responseHeaders[name]
      continue
    }
    if (!isValidResponseHeader(name, value, HTTP_HEADER_NAME_PATTERN, strictSingleValueFields)) return
  }

  return responseHeaders
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {RegExp} namePattern
 * @param {boolean} strictSingleValueFields
 * @returns {boolean}
 */
function isValidResponseHeader (name, value, namePattern, strictSingleValueFields) {
  if (!isStableHeaderValue(value)) return false
  if (name[0] === ':') return name === HTTP2_HEADER_STATUS
  if (!namePattern.test(name) || ILLEGAL_CONNECTION_HEADERS.has(name)) return false
  if (strictSingleValueFields && Array.isArray(value) &&
    value.length > 1 && SINGLE_VALUE_HEADERS.has(name)) return false
  if (name !== 'te') return true

  if (!Array.isArray(value)) return value === 'trailers'
  return value.length === 1 && Object.getOwnPropertyDescriptor(value, '0')?.value === 'trailers'
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
    statusCode: getResponseStatusCode(responseHeaders),
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
  const responseHeaders = addResponseHeaders({}, stream.sentHeaders)
  const abortController = new AbortController()
  startWriteHeadCh.publish({
    req: ctx.req,
    res: ctx.res,
    abortController,
    statusCode: responseHeaders[HTTP2_HEADER_STATUS] ?? 200,
    responseHeaders,
  })
  if (!abortController.signal.aborted) return false

  markStreamResponseBlocked(ctx)
  return true
}

/**
 * @param {StreamRequestContext} ctx
 */
function markStreamResponseBlocked (ctx) {
  if (ctx.responseBlocked) return

  ctx.responseBlocked = true
  if (!ctx.responseClosed) activeBlockedStreamCount++
}

/**
 * @param {Record<string, unknown>} responseHeaders
 * @param {object | unknown[]} [headers]
 */
function addResponseHeaders (responseHeaders, headers) {
  if (Array.isArray(headers)) {
    const addedNames = new Set()
    for (let i = 0; i < headers.length; i += 2) {
      const rawName = headers[i]
      const name = rawName.toLowerCase()
      addResponseHeader(responseHeaders, name, headers[i + 1], addedNames)
    }
  } else if (headers) {
    const addedNames = new Set()
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
  const values = []
  if (Array.isArray(previous)) {
    for (let i = 0; i < previous.length; i++) {
      values.push(previous[i])
    }
  } else {
    values.push(previous)
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      values.push(value[i])
    }
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
 * @property {boolean} [responseClosed] the terminal close was processed
 * @property {false} [strictSingleValueFields] mirrors relaxed Node response validation
 */

// Present the core-API stream + pseudo-header map as the minimal req/res pair
// the shared web lifecycle (`web.js`) consumes. The response status and headers
// are getters because `stream.sentHeaders` is empty until `stream.respond()`
// runs in the user handler; a snapshot taken here would always be `undefined`.
/**
 * @param {import('node:http2').ServerHttp2Stream} stream
 * @param {import('node:http2').IncomingHttpHeaders} headers
 * @param {boolean} strictSingleValueFields
 * @returns {StreamRequestContext}
 */
function createStreamAdapter (stream, headers, strictSingleValueFields) {
  const req = {
    stream,
    headers,
    method: headers[HTTP2_HEADER_METHOD],
    url: headers[HTTP2_HEADER_PATH],
    socket: stream.session?.socket,
  }
  const res = new Http2StreamResponse(stream, req)
  const ctx = { req, res, isStream: true }
  if (!strictSingleValueFields) ctx.strictSingleValueFields = false

  return ctx
}
