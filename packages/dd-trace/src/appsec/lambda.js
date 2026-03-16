'use strict'

const { HTTP_CLIENT_IP } = require('../../../../ext/tags')

const log = require('../log')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const waf = require('./waf')

/**
 * Maps pre-extracted HTTP data from the Lambda event to WAF addresses,
 * runs the WAF, and reports results on the span.
 *
 * @param {{ span: object, headers: Record<string, string>, method: string, path: string,
 *           query: Record<string, string | string[]> | undefined, body: string | object | undefined,
 *           isBase64Encoded: boolean, clientIp: string | undefined,
 *           pathParams: Record<string, string> | undefined,
 *           cookies: Record<string, string> | undefined,
 *           route: string | undefined }} data
 */
function onLambdaStartInvocation (data) {
  try {
    const { span, headers, method, path, query, body, clientIp, pathParams, cookies } = data

    if (!span) {
      log.warn('[ASM] No span provided in Lambda start invocation')
      return
    }

    const invocationKey = {}
    span._lambdaAppsecKey = invocationKey

    span.setTag('_dd.appsec.enabled', 1)

    if (clientIp) {
      span.setTag(HTTP_CLIENT_IP, clientIp)
    }

    const persistent = {}

    if (path) {
      persistent[addresses.HTTP_INCOMING_URL] = path
    }

    if (method) {
      persistent[addresses.HTTP_INCOMING_METHOD] = method
    }

    if (headers) {
      persistent[addresses.HTTP_INCOMING_HEADERS] = headers
    }

    if (clientIp) {
      persistent[addresses.HTTP_CLIENT_IP] = clientIp
    }

    if (query) {
      persistent[addresses.HTTP_INCOMING_QUERY] = query
    }

    if (body !== undefined && body !== null) {
      persistent[addresses.HTTP_INCOMING_BODY] = body
    }

    if (pathParams) {
      persistent[addresses.HTTP_INCOMING_PARAMS] = pathParams
    }

    if (cookies) {
      persistent[addresses.HTTP_INCOMING_COOKIES] = cookies
    }

    waf.run({ persistent }, invocationKey, undefined, span)
  } catch (err) {
    log.error('[ASM] Error in Lambda start-invocation handler', err)
  }
}

/**
 * Maps response data to WAF addresses, runs a final WAF pass,
 * disposes the WAF context, and finishes the request report.
 *
 * @param {{ span: object, statusCode: string | undefined,
 *           responseHeaders: Record<string, string> | undefined }} data
 */
function onLambdaEndInvocation (data) {
  try {
    const { span, statusCode, responseHeaders } = data

    if (!span) {
      log.warn('[ASM] No span provided in Lambda end invocation')
      return
    }

    const invocationKey = span._lambdaAppsecKey
    if (!invocationKey) {
      return
    }

    const persistent = {}

    if (statusCode) {
      persistent[addresses.HTTP_INCOMING_RESPONSE_CODE] = String(statusCode)
    }

    if (responseHeaders) {
      const filteredHeaders = { ...responseHeaders }
      delete filteredHeaders['set-cookie']
      persistent[addresses.HTTP_INCOMING_RESPONSE_HEADERS] = filteredHeaders
    }

    if (Object.keys(persistent).length > 0) {
      waf.run({ persistent }, invocationKey, undefined, span)
    }

    waf.disposeContext(invocationKey)

    Reporter.finishRequest(null, null, {}, undefined, span)

    delete span._lambdaAppsecKey
  } catch (err) {
    log.error('[ASM] Error in Lambda end-invocation handler', err)
  }
}

module.exports = {
  onLambdaStartInvocation,
  onLambdaEndInvocation,
}
