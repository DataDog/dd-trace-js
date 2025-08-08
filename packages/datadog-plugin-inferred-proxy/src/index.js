'use strict'

const WebPlugin = require('../../datadog-plugin-web/src')
const log = require('../../dd-trace/src/log')
const tags = require('../../../ext/tags')

const RESOURCE_NAME = tags.RESOURCE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const HTTP_URL = tags.HTTP_URL
const HTTP_METHOD = tags.HTTP_METHOD

const PROXY_HEADER_SYSTEM = 'x-dd-proxy'
const PROXY_HEADER_START_TIME_MS = 'x-dd-proxy-request-time-ms'
const PROXY_HEADER_PATH = 'x-dd-proxy-path'
const PROXY_HEADER_HTTPMETHOD = 'x-dd-proxy-httpmethod'
const PROXY_HEADER_DOMAIN = 'x-dd-proxy-domain-name'
const PROXY_HEADER_STAGE = 'x-dd-proxy-stage'

class InferredProxyPlugin extends WebPlugin {
  static id = 'inferred-proxy'

  constructor (...args) {
    super(...args)

    this.supportedProxies = {
      'aws-apigateway': {
        spanName: 'aws.apigateway',
        component: 'aws-apigateway'
      }
    }
  }

  startChildSpan (tracer, config, name, req, traceCtx) {
    const headers = req.headers
    const reqCtx = this.getContext(req)
    let childOf = super.startChildSpan(tracer, config, name, req, traceCtx)

    if (!headers) {
      return childOf
    }

    if (!tracer._config?.inferredProxyServicesEnabled) {
      return childOf
    }

    const proxyContext = this.extractInferredProxyContext(headers)

    if (!proxyContext) {
      return childOf
    }

    const proxySpanInfo = this.supportedProxies[proxyContext.proxySystemName]

    log.debug('Successfully extracted inferred span info %s for proxy:', proxyContext, proxyContext.proxySystemName)

    const span = super.startSpan(proxySpanInfo.spanName, {
      childOf,
      type: 'web',
      startTime: proxyContext.requestTime,
      integrationName: proxySpanInfo.component,
      meta: {
        service: proxyContext.domainName || tracer._config.service,
        component: proxySpanInfo.component,
        [SPAN_TYPE]: 'web',
        [HTTP_METHOD]: proxyContext.method,
        [HTTP_URL]: proxyContext.domainName + proxyContext.path,
        stage: proxyContext.stage
      }
    }, traceCtx, config)

    reqCtx.inferredProxySpan = span
    childOf = span

    log.debug('Successfully created inferred proxy span.')

    this.setInferredProxySpanTags(span, proxyContext)

    return childOf
  }

  setInferredProxySpanTags (span, proxyContext) {
    span.setTag(RESOURCE_NAME, `${proxyContext.method} ${proxyContext.path}`)
    span.setTag('_dd.inferred_span', 1)
    return span
  }

  extractInferredProxyContext (headers) {
    if (!(PROXY_HEADER_START_TIME_MS in headers)) {
      return null
    }

    if (!(PROXY_HEADER_SYSTEM in headers && headers[PROXY_HEADER_SYSTEM] in this.supportedProxies)) {
      log.debug('Received headers to create inferred proxy span but headers include an unsupported proxy type', headers)
      return null
    }

    return {
      requestTime: headers[PROXY_HEADER_START_TIME_MS]
        ? Number.parseInt(headers[PROXY_HEADER_START_TIME_MS], 10)
        : null,
      method: headers[PROXY_HEADER_HTTPMETHOD],
      path: headers[PROXY_HEADER_PATH],
      stage: headers[PROXY_HEADER_STAGE],
      domainName: headers[PROXY_HEADER_DOMAIN],
      proxySystemName: headers[PROXY_HEADER_SYSTEM]
    }
  }

  finishAll (context) {
    super.finishAll(context)
    this.finishInferredProxySpan(context)
  }

  finishInferredProxySpan (context) {
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
}

module.exports = InferredProxyPlugin
