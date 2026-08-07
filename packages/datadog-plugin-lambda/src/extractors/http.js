'use strict'

const log = require('../../../dd-trace/src/log')

const AUTHORIZING_REQUEST_ID_HEADER = 'x-datadog-authorizing-requestid'

const HTTPEventSubtype = {
  ApiGatewayV1: 'api-gateway-rest-api',
  ApiGatewayV2: 'api-gateway-http-api',
  ApiGatewayWebSocket: 'api-gateway-websocket',
  Unknown: 'unknown-sub-type',
}

function getEventSubtype (event) {
  if (event.requestContext?.stage !== undefined && event.httpMethod !== undefined && event.resource !== undefined) {
    return HTTPEventSubtype.ApiGatewayV1
  }
  if (
    event.requestContext !== undefined &&
    event.version === '2.0' &&
    event.rawQueryString !== undefined &&
    !event.requestContext.domainName?.includes('lambda-url')
  ) {
    return HTTPEventSubtype.ApiGatewayV2
  }
  if (event.requestContext !== undefined && event.requestContext.messageDirection !== undefined) {
    return HTTPEventSubtype.ApiGatewayWebSocket
  }
  return HTTPEventSubtype.Unknown
}

function getInjectedAuthorizerHeaders (event, eventSubtype) {
  const authorizerHeaders = event?.requestContext?.authorizer
  if (!authorizerHeaders) return null

  let rawDatadogData = authorizerHeaders._datadog
  if (eventSubtype === HTTPEventSubtype.ApiGatewayV2) {
    rawDatadogData = authorizerHeaders.lambda?._datadog
  }
  if (!rawDatadogData) return null

  const injectedData = JSON.parse(Buffer.from(rawDatadogData, 'base64').toString())

  if (
    authorizerHeaders.integrationLatency > 0 ||
    event.requestContext.requestId === injectedData[AUTHORIZING_REQUEST_ID_HEADER]
  ) {
    return injectedData
  }

  return null
}

function extract (event, tracer, config) {
  const decodeAuthorizerContext = config?.decodeAuthorizerContext !== false

  if (decodeAuthorizerContext) {
    try {
      const eventSourceSubtype = getEventSubtype(event)
      const injectedAuthorizerHeaders = getInjectedAuthorizerHeaders(event, eventSourceSubtype)
      if (injectedAuthorizerHeaders !== null) {
        const spanContext = tracer.extract('text_map', injectedAuthorizerHeaders)
        if (spanContext === null) return null

        log.debug('Extracted trace context from authorizer event')
        return spanContext
      }
    } catch (error) {
      log.debug('Unable to extract trace context from authorizer event: %s', error.message)
    }
  }

  const headers = event.headers ?? event.multiValueHeaders
  if (!headers || typeof headers !== 'object') return null

  const lowerCaseHeaders = {}
  for (const key of Object.keys(headers)) {
    const val = headers[key]
    if (Array.isArray(val)) {
      lowerCaseHeaders[key.toLowerCase()] = val[0] ?? ''
    } else if (typeof val === 'string') {
      lowerCaseHeaders[key.toLowerCase()] = val
    }
  }

  const spanContext = tracer.extract('text_map', lowerCaseHeaders)
  if (spanContext === null) return null

  log.debug('Extracted trace context from HTTP event')
  return spanContext
}

module.exports = {
  extract,
  getEventSubtype,
  getInjectedAuthorizerHeaders,
  HTTPEventSubtype,
  AUTHORIZING_REQUEST_ID_HEADER,
}
