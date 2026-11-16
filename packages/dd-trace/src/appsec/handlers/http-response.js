'use strict'

const { Stream } = require('node:stream')

const web = require('../../plugins/util/web')
const { isEmpty } = require('../../util')
const addresses = require('../addresses')
const apiSecurity = require('../api_security')
const { isBlocked, callBlockDelegation, handleResults } = require('../blocking')
const { getActiveRequest } = require('../store')
const waf = require('../waf')
const { storedResponseHeaders, copyHeadersOmitting } = require('./http-shared')

const responseAnalyzedSet = new WeakSet()
const nextResponseBodies = new WeakMap()

/**
 * @param {unknown} body
 * @returns {body is object}
 */
function isJsonBody (body) {
  return body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Stream)
}

/**
 * @param {{ stream: ReadableStream | null, body: unknown }} ctx
 */
function onNextJsonResponse ({ stream, body }) {
  // NextResponse wraps the native Response but retains its body stream.
  if (stream && isJsonBody(body)) nextResponseBodies.set(stream, body)
}

/**
 * Pages Router `res.json()` and `res.send()`.
 *
 * @param {{ arguments: unknown[] }} ctx
 */
function onNextResponseBody (ctx) {
  const body = ctx.arguments[0]
  if (!isJsonBody(body)) return

  const req = /** @type {import('node:http').IncomingMessage | undefined} */ (getActiveRequest())
  if (!req || req.method === 'HEAD') return

  const res = web.getContext(req)?.res
  if (res) onResponseBody({ req, res, body })
}

/**
 * App Router route handler result. Only the returned response is analyzed.
 *
 * @param {{ result?: Response, error?: unknown }} ctx
 */
function onNextAppRouteResponse (ctx) {
  // Async completion is also published for rejected route handlers, including rejection with undefined.
  if ('error' in ctx) return

  const response = ctx.result
  const body = response?.body && nextResponseBodies.get(response.body)
  if (!body) return

  const req = /** @type {import('node:http').IncomingMessage | undefined} */ (getActiveRequest())
  if (!req || req.method === 'HEAD') return

  onResponseBody({ req, res: { statusCode: response.status }, body })
}

function onResponseBody ({ req, res, body }) {
  if (
    !body ||
    typeof body !== 'object' ||
    apiSecurity.sampleRequest(req, res) !== apiSecurity.SamplingDecision.SAMPLE
  ) {
    return
  }

  // we don't support blocking at this point, so no results needed
  waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_RESPONSE_BODY]: body,
    },
  }, req)
}

function onResponseWriteHead ({ req, res, abortController, statusCode, responseHeaders }) {
  // Normalize header names to lowercase so downstream consumers see the same shape
  // regardless of how the caller wrote them.
  const normalizedResponseHeaders = {}
  for (const [key, value] of Object.entries(responseHeaders)) {
    normalizedResponseHeaders[key.toLowerCase()] = value
  }

  if (!isEmpty(normalizedResponseHeaders)) {
    storedResponseHeaders.set(req, normalizedResponseHeaders)
  }

  // TODO: do not call waf if inside block()
  // if (isBlocking()) {
  //   return
  // }

  // avoid "write after end" error
  if (isBlocked(res) || callBlockDelegation(res)) {
    abortController?.abort()
    return
  }

  // avoid double waf call
  if (responseAnalyzedSet.has(res)) {
    return
  }

  const rootSpan = web.root(req)
  if (!rootSpan) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_RESPONSE_CODE]: String(statusCode),
      [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: copyHeadersOmitting(normalizedResponseHeaders, 'set-cookie'),
    },
  }, req)

  responseAnalyzedSet.add(res)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onResponseOperation ({ res, abortController }) {
  if (isBlocked(res)) {
    abortController?.abort()
  }
}

module.exports = {
  onNextAppRouteResponse,
  onNextResponseBody,
  onNextJsonResponse,
  onResponseBody,
  onResponseWriteHead,
  onResponseOperation,
}
