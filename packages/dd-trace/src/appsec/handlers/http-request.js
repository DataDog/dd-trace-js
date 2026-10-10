'use strict'

const { HTTP_CLIENT_IP } = require('../../../../../ext/tags')
const log = require('../../log')
const web = require('../../plugins/util/web')
const { extractIp } = require('../../plugins/util/ip_extractor')
const { isEmpty } = require('../../util')
const addresses = require('../addresses')
const apiSecurity = require('../api_security')
const { normalizeRoute } = require('../api_security/normalized-route')
const { handleResults } = require('../blocking')
const Reporter = require('../reporter')
const { getActiveRequest, getCanonicalRequest } = require('../store')
const waf = require('../waf')
const { storedResponseHeaders, copyHeadersOmitting } = require('./http-shared')

const analyzedBodies = new WeakSet()
const analyzedCookies = new WeakSet()
const storedBodies = new WeakMap()

let config

/**
 * @param {import('../../config/config-base')|undefined} _config
 */
function setConfig (_config) {
  config = _config
}

function onRequestBodyParsed ({ req, res, body, abortController }) {
  if (body === undefined || body === null) return

  if (!req) {
    req = getActiveRequest()
  }
  req = getCanonicalRequest(req)

  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (!req.body) {
    // do not store body if it is in req.body
    storedBodies.set(req, body)
  }

  if (typeof body === 'object') {
    if (isEmpty(body)) return
    analyzedBodies.add(body)
  }

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_BODY]: body,
    },
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onRequestCookieParser ({ req, res, abortController, cookies }) {
  if (!cookies || typeof cookies !== 'object') return

  req = getCanonicalRequest(req)
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (isEmpty(cookies)) return
  analyzedCookies.add(cookies)

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_COOKIES]: cookies,
    },
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function incomingHttpStartTranslator ({ req, res, abortController }) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const clientIp = extractIp(config, req)

  rootSpan.addTags({
    '_dd.appsec.enabled': 1,
    '_dd.runtime_family': 'nodejs',
    [HTTP_CLIENT_IP]: clientIp,
  })

  if (config.inferredProxyServicesEnabled) {
    const context = web.getContext(req)
    if (context?.inferredProxySpan) {
      context.inferredProxySpan.setTag('_dd.appsec.enabled', 1)
    }
  }

  const persistent = {
    [addresses.HTTP_INCOMING_URL]: req.url,
    [addresses.HTTP_INCOMING_HEADERS]: copyHeadersOmitting(req.headers, 'cookie'),
    [addresses.HTTP_INCOMING_METHOD]: req.method,
  }

  if (clientIp) {
    persistent[addresses.HTTP_CLIENT_IP] = clientIp
  }

  const results = waf.run({ persistent }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function incomingHttpEndTranslator ({ req, res }) {
  const persistent = {}

  // we need to keep this to support other body parsers
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') {
      if (!isEmpty(req.body) && !analyzedBodies.has(req.body)) {
        persistent[addresses.HTTP_INCOMING_BODY] = req.body
      }
    } else {
      persistent[addresses.HTTP_INCOMING_BODY] = req.body
    }
  }

  // we need to keep this to support other cookie parsers
  if (
    req.cookies !== null &&
    typeof req.cookies === 'object' &&
    !isEmpty(req.cookies) &&
    !analyzedCookies.has(req.cookies)
  ) {
    persistent[addresses.HTTP_INCOMING_COOKIES] = req.cookies
  }

  // we need to keep this to support nextjs
  const query = req.query
  if (
    query !== null &&
    typeof query === 'object' &&
    !isEmpty(query)
  ) {
    persistent[addresses.HTTP_INCOMING_QUERY] = query
  }

  // This hook runs before span finish, so ensure route/endpoint tags are available before API Security sampling runs.
  web.setRouteOrEndpointTag(req)

  if (config.appsec.DD_API_SECURITY_ENABLED) {
    try {
      const normalized = normalizeRoute(req)
      if (normalized !== null) {
        web.root(req)?.setTag('_dd.appsec.normalized_route', normalized)
      }
    } catch (e) {
      log.debug('[ASM] Unable to compute normalized route: %s', e.message)
    }
  }

  const apiSecSamplingDecision = apiSecurity.sampleRequest(req, res, true)
  if (apiSecSamplingDecision === apiSecurity.SamplingDecision.SAMPLE) {
    persistent[addresses.WAF_CONTEXT_PROCESSOR] = { 'extract-schema': true }
  }

  let wafResult
  if (!isEmpty(persistent)) {
    wafResult = waf.run({ persistent }, req)
  }

  apiSecurity.reportRequest(req, apiSecSamplingDecision, wafResult)

  waf.disposeContext(req)

  const storedHeaders = storedResponseHeaders.get(req) || {}

  const body = req.body || storedBodies.get(req)
  Reporter.finishRequest(req, res, storedHeaders, body)

  if (storedHeaders) {
    storedResponseHeaders.delete(req)
  }
  storedBodies.delete(req)
}

function onRequestQueryParsed ({ req, res, query, abortController }) {
  if (!query || typeof query !== 'object') return

  if (!req) {
    req = getActiveRequest()
  }
  req = getCanonicalRequest(req)

  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (isEmpty(query)) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_QUERY]: query,
    },
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onRequestProcessParams ({ req, res, abortController, params }) {
  req = getCanonicalRequest(req)
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (!params || typeof params !== 'object' || isEmpty(params)) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_PARAMS]: params,
    },
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

module.exports = {
  setConfig,
  onRequestBodyParsed,
  onRequestCookieParser,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator,
  onRequestQueryParsed,
  onRequestProcessParams,
}
