const log = require('../../log')
const tags = require('../../../../../ext/tags')

const RESOURCE_NAME = tags.RESOURCE_NAME
const HTTP_ROUTE = tags.HTTP_ROUTE
const SPAN_KIND = tags.SPAN_KIND
const HTTP_URL = tags.HTTP_URL
const HTTP_METHOD = tags.HTTP_METHOD

const PROXY_HEADER_NAME = 'x-dd-proxy-name'
const PROXY_HEADER_START_TIME_MS = 'x-dd-proxy-request-time'
const PROXY_HEADER_PATH = 'x-dd-proxy-path'
const PROXY_HEADER_HTTPMETHOD = 'x-dd-proxy-httpmethod'
const PROXY_HEADER_DOMAIN = 'x-dd-proxy-domain-name'
const PROXY_HEADER_STAGE = 'x-dd-proxy-stage'

const proxySpanNames = {
  'aws-apigateway': 'aws.apigateway'
}

function createInferredProxySpan (headers, childOf, tracer, context) {
  if (!headers) {
    return null
  }

  if (!tracer._config.managedServicesEnabled) {
    return null
  }

  const proxyContext = extractInferredProxyContext(headers)

  if (!proxyContext) {
    return null
  }

  log.debug('Starting inferred Proxy span')

  const span = tracer.startSpan(
    proxySpanNames[proxyContext.proxyName],
    {
      childOf,
      type: 'web',
      startTime: proxyContext.requestTime,
      tags: {
        service: proxyContext.domainName || this.serviceName(),
        component: proxyContext.proxyName,
        [SPAN_KIND]: 'internal',
        [HTTP_METHOD]: proxyContext.method,
        [HTTP_URL]: proxyContext.domainName + proxyContext.path,
        [HTTP_ROUTE]: proxyContext.path,
        stage: proxyContext.stage,
        type: 'web'
      }
    }
  )

  tracer.scope().activate(span)
  context.inferredProxySpan = span
  childOf = span

  log.debug('Ending inferred Proxy span')

  setInferredProxySpanTags(span, proxyContext)

  return childOf
}

function setInferredProxySpanTags (span, proxyContext) {
  span.setTag(RESOURCE_NAME, `${proxyContext.method} ${proxyContext.path}`)
  return span
}

function extractInferredProxyContext (headers) {
  if (!(PROXY_HEADER_START_TIME_MS in headers)) {
    return null
  }

  return {
    requestTime: headers[PROXY_HEADER_START_TIME_MS]
      ? parseInt(headers[PROXY_HEADER_START_TIME_MS], 10)
      : null,
    method: headers[PROXY_HEADER_HTTPMETHOD],
    path: headers[PROXY_HEADER_PATH],
    stage: headers[PROXY_HEADER_STAGE],
    domainName: headers[PROXY_HEADER_DOMAIN],
    proxyName: headers[PROXY_HEADER_NAME]
  }
}

function finishInferredProxySpan (context) {
  const { req, res } = context

  if (context.inferredProxySpanFinished && !req.stream) return

  context.config.hooks.request(context.inferredProxySpan, req, res)

  // Only close the inferred span if one was created
  if (context.inferredProxySpan) {
    context.inferredProxySpan.finish()
    context.inferredProxySpanFinished = true
  }
}

module.exports = {
  createInferredProxySpan,
  finishInferredProxySpan
}
