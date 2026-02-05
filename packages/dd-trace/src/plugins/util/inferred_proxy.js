'use strict'

const log = require('../../log')
const tags = require('../../../../../ext/tags')

const RESOURCE_NAME = tags.RESOURCE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const HTTP_URL = tags.HTTP_URL
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_ROUTE = tags.HTTP_ROUTE

const PROXY_HEADER_SYSTEM = 'x-dd-proxy'
const PROXY_HEADER_START_TIME_MS = 'x-dd-proxy-request-time-ms'
const PROXY_HEADER_PATH = 'x-dd-proxy-path'
const PROXY_HEADER_HTTPMETHOD = 'x-dd-proxy-httpmethod'
const PROXY_HEADER_DOMAIN = 'x-dd-proxy-domain-name'
const PROXY_HEADER_STAGE = 'x-dd-proxy-stage'
const PROXY_HEADER_REGION = 'x-dd-proxy-region'
const PROXY_HEADER_RESOURCE_PATH = 'x-dd-proxy-resource-path'
const PROXY_HEADER_ACCOUNT_ID = 'x-dd-proxy-account-id'
const PROXY_HEADER_API_ID = 'x-dd-proxy-api-id'
const PROXY_HEADER_REGION = 'x-dd-proxy-region'
const PROXY_HEADER_AWS_USER = 'x-dd-proxy-user'

const supportedProxies = {
  'aws-apigateway': {
    spanName: 'aws.apigateway',
    component: 'aws-apigateway',
  },
  'aws-httpapi': {
    spanName: 'aws.httpapi',
    component: 'aws-httpapi',
  },
  'azure-apim': {
    spanName: 'azure.apim',
    component: 'azure-apim',
  },
}

function createInferredProxySpan (headers, childOf, tracer, reqCtx, traceCtx, config, startSpanHelper) {
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

  log.debug('Successfully extracted inferred span info %s for proxy:', proxyContext, proxyContext.proxySystemName)

  const span = startSpanHelper(tracer, proxySpanInfo.spanName, {
    childOf,
    type: 'web',
    startTime: proxyContext.requestTime,
    integrationName: proxySpanInfo.component,
    meta: {
      service: proxyContext.domainName || tracer._config.service,
      component: proxySpanInfo.component,
      [SPAN_TYPE]: 'web',
      [SPAN_KIND]: 'server',
      [HTTP_METHOD]: proxyContext.method,
      [HTTP_URL]: 'https://' + proxyContext.domainName + proxyContext.path,
      stage: proxyContext.stage,
      region: proxyContext.region,
      ...(proxyContext.resourcePath && { [HTTP_ROUTE]: proxyContext.resourcePath }),
      ...(proxyContext.accountId && { account_id: proxyContext.accountId }),
      ...(proxyContext.apiId && { apiid: proxyContext.apiId }),
      ...(proxyContext.region && { region: proxyContext.region }),
      ...(proxyContext.awsUser && { aws_user: proxyContext.awsUser }),
    },
  }, traceCtx, config)

  reqCtx.inferredProxySpan = span
  childOf = span

  log.debug('Successfully created inferred proxy span.')

  setInferredProxySpanTags(span, proxyContext)

  return childOf
}

function setInferredProxySpanTags (span, proxyContext) {
  const resourcePath = proxyContext.resourcePath || proxyContext.path
  span.setTag(RESOURCE_NAME, `${proxyContext.method} ${resourcePath}`)
  span.setTag('_dd.inferred_span', 1)

  // Set dd_resource_key as API Gateway ARN if we have the required components
  if (proxyContext.apiId && proxyContext.region) {
    const partition = 'aws'
    // API Gateway v1 (REST): arn:{partition}:apigateway:{region}::/restapis/{api-id}
    // API Gateway v2 (HTTP): arn:{partition}:apigateway:{region}::/apis/{api-id}
    const apiType = proxyContext.proxySystemName === 'aws-httpapi' ? 'apis' : 'restapis'
    span.setTag(
      'dd_resource_key',
      `arn:${partition}:apigateway:${proxyContext.region}::/${apiType}/${proxyContext.apiId}`
    )
  }

  return span
}

function extractInferredProxyContext (headers) {
  if (!(PROXY_HEADER_START_TIME_MS in headers)) {
    return null
  }

  if (!(PROXY_HEADER_SYSTEM in headers && headers[PROXY_HEADER_SYSTEM] in supportedProxies)) {
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
    proxySystemName: headers[PROXY_HEADER_SYSTEM],
    region: headers[PROXY_HEADER_REGION],
    resourcePath: headers[PROXY_HEADER_RESOURCE_PATH],
    accountId: headers[PROXY_HEADER_ACCOUNT_ID],
    apiId: headers[PROXY_HEADER_API_ID],
    region: headers[PROXY_HEADER_REGION],
    awsUser: headers[PROXY_HEADER_AWS_USER],
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
  finishInferredProxySpan,
}
