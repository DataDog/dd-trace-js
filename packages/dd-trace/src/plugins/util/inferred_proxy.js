const log = require('../../log')
const tags = require('../../../../../ext/tags')

const RESOURCE_NAME = tags.RESOURCE_NAME
const SPAN_KIND = tags.SPAN_KIND
const SPAN_TYPE = tags.SPAN_TYPE
const HTTP_URL = tags.HTTP_URL
const HTTP_METHOD = tags.HTTP_METHOD

const PROXY_HEADER_SYSTEM = 'x-dd-proxy'
const PROXY_HEADER_START_TIME_MS = 'x-dd-proxy-request-time-ms'
const PROXY_HEADER_PATH = 'x-dd-proxy-path'
const PROXY_HEADER_HTTPMETHOD = 'x-dd-proxy-httpmethod'
const PROXY_HEADER_DOMAIN = 'x-dd-proxy-domain-name'
const PROXY_HEADER_STAGE = 'x-dd-proxy-stage'

const supportedProxies = {
  'aws-apigateway': {
    spanName: 'aws.apigateway',
    component: 'aws-apigateway'
  }
}

function createInferredProxySpan (headers, childOf, tracer, context) {
  if (!headers) {
    return null
  }

  if (!tracer._config?.inferredProxyServicesEnabled) {
    return null
  }

  const proxyContext = extractInferredProxyContext(headers)

  if (!proxyContext) {
    return null
  }

  const proxySpanInfo = supportedProxies[proxyContext.proxySystemName]

  log.debug(`Successfully extracted inferred span info ${proxyContext} for proxy: ${proxyContext.proxySystemName}`)

  const span = tracer.startSpan(
    proxySpanInfo.spanName,
    {
      childOf,
      type: 'web',
      startTime: proxyContext.requestTime,
      tags: {
        service: proxyContext.domainName || tracer._config.service,
        component: proxySpanInfo.component,
        [SPAN_KIND]: 'internal',
        [SPAN_TYPE]: 'web',
        [HTTP_METHOD]: proxyContext.method,
        [HTTP_URL]: proxyContext.domainName + proxyContext.path,
        stage: proxyContext.stage
      }
    }
  )

  tracer.scope().activate(span)
  context.inferredProxySpan = span
  childOf = span

  log.debug('Successfully created inferred proxy span.')

  setInferredProxySpanTags(span, proxyContext)

  return childOf
}

function setInferredProxySpanTags (span, proxyContext) {
  span.setTag(RESOURCE_NAME, `${proxyContext.method} ${proxyContext.path}`)
  span.setTag('_dd.inferred_span', '1')
  return span
}

function extractInferredProxyContext (headers) {
  if (!(PROXY_HEADER_START_TIME_MS in headers)) {
    return null
  }

  if (!(PROXY_HEADER_SYSTEM in headers && headers[PROXY_HEADER_SYSTEM] in supportedProxies)) {
    log.debug(`Received headers to create inferred proxy span but headers include an unsupported proxy type ${headers}`)
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
    proxySystemName: headers[PROXY_HEADER_SYSTEM]
  }
}

function finishInferredProxySpan (context) {
  const { req } = context

  if (!context.inferredProxySpan) return

  if (context.inferredProxySpanFinished && !req.stream) return

  // context.config.hooks.request(context.inferredProxySpan, req, res) # TODO: Do we need this??

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
