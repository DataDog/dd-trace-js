'use strict'

const log = require('../../../dd-trace/src/log')
const { isAPIGatewayEventV2, isAPIGatewayEvent } = require('../event-type-guards')

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

module.exports = { extractHTTP, getInjectedAuthorizerHeaders, AUTHORIZING_REQUEST_ID_HEADER }
