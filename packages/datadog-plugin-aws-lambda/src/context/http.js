'use strict'

const log = require('../../../dd-trace/src/log')
const { isAPIGatewayEventV2, isAPIGatewayEvent } = require('../event-type-guards')

const PARENT_SPAN_FINISH_TIME_HEADER = 'x-datadog-parent-span-finish-time'
const AUTHORIZING_REQUEST_ID_HEADER = 'x-datadog-authorizing-requestid'

/**
 * Decodes the authorizer's carrier only for an uncached authorization.
 * @param {Record<string, unknown>} event HTTP event.
 * @returns {Record<string, string>|null}
 */
function getInjectedAuthorizerHeaders (event) {
  const authorizer = event?.requestContext?.authorizer
  if (!authorizer) return null
  let raw = authorizer._datadog
  // Keep REST classification ahead of HTTP API classification for overlapping shapes.
  if (!isAPIGatewayEvent(event) && isAPIGatewayEventV2(event)) raw = authorizer.lambda._datadog
  if (!raw) return null
  const headers = JSON.parse(Buffer.from(raw, 'base64').toString())
  if (authorizer.integrationLatency > 0 ||
      event.requestContext.requestId === headers[AUTHORIZING_REQUEST_ID_HEADER]) return headers
  return null
}

/**
 * @param {Record<string, unknown>} event HTTP event.
 * @param {import('../../../dd-trace/src/opentracing/tracer')} tracer Core tracer.
 * @param {boolean} [decodeAuthorizerContext] Decode authorizer metadata.
 * @returns {import('../../../dd-trace/src/opentracing/span_context')|null}
 */
function extractHTTP (event, tracer, decodeAuthorizerContext = true) {
  if (decodeAuthorizerContext) {
    try {
      const injected = getInjectedAuthorizerHeaders(event)
      if (injected !== null) return tracer.extract('text_map', injected)
    } catch (error) {
      log.debug('Unable to extract trace context from authorizer event: %s', error)
    }
  }
  const headers = event.headers ?? event.multiValueHeaders
  const carrier = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) carrier[key.toLowerCase()] = value[0] ?? ''
    else if (typeof value === 'string') carrier[key.toLowerCase()] = value
  }
  return tracer.extract('text_map', carrier)
}

/**
 * Carries the authorizer's selected span into an uncached API Gateway integration.
 * @param {import('../../../dd-trace/src/opentracing/tracer')} tracer Core tracer.
 * @param {Record<string, unknown>} result Authorizer response, mutated in place like the shim.
 * @param {import('../../../dd-trace/src/opentracing/span')} span Inferred or invocation span.
 * @param {string|undefined} requestId Request authorizer correlation; absent for token authorizers.
 * @param {number} finishTime Milliseconds since epoch.
 */
function injectAuthorizerSpan (tracer, result, span, requestId, finishTime) {
  if (!result.context) result.context = {}
  const headers = {}
  tracer.inject(span, 'text_map', headers)
  // The wire value is nanoseconds for cross-language authorizers.
  headers[PARENT_SPAN_FINISH_TIME_HEADER] = finishTime * 1e6
  if (requestId) headers[AUTHORIZING_REQUEST_ID_HEADER] = requestId
  result.context._datadog = Buffer.from(JSON.stringify(headers)).toString('base64')
}

module.exports = {
  extractHTTP,
  getInjectedAuthorizerHeaders,
  injectAuthorizerSpan,
  AUTHORIZING_REQUEST_ID_HEADER,
  PARENT_SPAN_FINISH_TIME_HEADER,
}
