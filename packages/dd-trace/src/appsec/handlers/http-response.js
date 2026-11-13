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

/**
 * @param {{ arguments?: unknown[], body?: unknown, statusCode?: number }} ctx
 */
function onNextResponseBody (ctx) {
  const body = ctx.arguments ? ctx.arguments[0] : ctx.body
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body) || body instanceof Stream) return

  const req = getActiveRequest()
  if (!req) return

  // A Web Response has its final status before Next copies it to the Node response.
  const res = ctx.statusCode ? { statusCode: ctx.statusCode } : web.getContext(req)?.res
  if (res) onResponseBody({ req, res, body })
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
  onNextResponseBody,
  onResponseBody,
  onResponseWriteHead,
  onResponseOperation,
}
