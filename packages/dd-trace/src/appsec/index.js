'use strict'

const log = require('../log')
const RuleManager = require('./rule_manager')
const remoteConfig = require('./remote_config')
const {
  bodyParser,
  cookieParser,
  incomingHttpRequestStart,
  incomingHttpRequestEnd,
  passportVerify,
  queryParser,
  nextBodyParsed,
  nextQueryParsed,
  responseBody,
  responseWriteHead
} = require('./channels')
const waf = require('./waf')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const appsecTelemetry = require('./telemetry')
const apiSecuritySampler = require('./api_security_sampler')
const web = require('../plugins/util/web')
const { extractIp } = require('../plugins/util/ip_extractor')
const { HTTP_CLIENT_IP } = require('../../../../ext/tags')
const { block, setTemplates, getBlockingAction } = require('./blocking')
const { passportTrackEvent } = require('./passport')
const { storage } = require('../../../datadog-core')
const graphql = require('./graphql')
const rasp = require('./rasp')

let isEnabled = false
let config

function enable (_config) {
  if (isEnabled) return

  try {
    appsecTelemetry.enable(_config.telemetry)
    graphql.enable()

    if (_config.appsec.rasp.enabled) {
      rasp.enable()
    }

    setTemplates(_config)

    RuleManager.loadRules(_config.appsec)

    remoteConfig.enableWafUpdate(_config.appsec)

    Reporter.setRateLimit(_config.appsec.rateLimit)

    apiSecuritySampler.configure(_config.appsec)

    incomingHttpRequestStart.subscribe(incomingHttpStartTranslator)
    incomingHttpRequestEnd.subscribe(incomingHttpEndTranslator)
    bodyParser.subscribe(onRequestBodyParsed)
    nextBodyParsed.subscribe(onRequestBodyParsed)
    nextQueryParsed.subscribe(onRequestQueryParsed)
    queryParser.subscribe(onRequestQueryParsed)
    cookieParser.subscribe(onRequestCookieParser)
    responseBody.subscribe(onResponseBody)
    responseWriteHead.subscribe(onResponseWriteHead)

    if (_config.appsec.eventTracking.enabled) {
      passportVerify.subscribe(onPassportVerify)
    }

    isEnabled = true
    config = _config
  } catch (err) {
    log.error('Unable to start AppSec')
    log.error(err)

    disable()
  }
}

function incomingHttpStartTranslator ({ req, res, abortController }) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const clientIp = extractIp(config, req)

  rootSpan.addTags({
    '_dd.appsec.enabled': 1,
    '_dd.runtime_family': 'nodejs',
    [HTTP_CLIENT_IP]: clientIp
  })

  const requestHeaders = Object.assign({}, req.headers)
  delete requestHeaders.cookie

  const persistent = {
    [addresses.HTTP_INCOMING_URL]: req.url,
    [addresses.HTTP_INCOMING_HEADERS]: requestHeaders,
    [addresses.HTTP_INCOMING_METHOD]: req.method
  }

  if (clientIp) {
    persistent[addresses.HTTP_CLIENT_IP] = clientIp
  }

  if (apiSecuritySampler.sampleRequest(req)) {
    persistent[addresses.WAF_CONTEXT_PROCESSOR] = { 'extract-schema': true }
  }

  const actions = waf.run({ persistent }, req)

  handleResults(actions, req, res, rootSpan, abortController)
}

function incomingHttpEndTranslator ({ req, res }) {
  const persistent = {}

  // we need to keep this to support other body parsers
  // TODO: no need to analyze it if it was already done by the body-parser hook
  if (req.body !== undefined && req.body !== null) {
    persistent[addresses.HTTP_INCOMING_BODY] = req.body
  }

  // TODO: temporary express instrumentation, will use express plugin later
  if (req.params && typeof req.params === 'object') {
    persistent[addresses.HTTP_INCOMING_PARAMS] = req.params
  }

  // we need to keep this to support other cookie parsers
  if (req.cookies && typeof req.cookies === 'object') {
    persistent[addresses.HTTP_INCOMING_COOKIES] = req.cookies
  }

  if (req.query && typeof req.query === 'object') {
    persistent[addresses.HTTP_INCOMING_QUERY] = req.query
  }

  if (Object.keys(persistent).length) {
    waf.run({ persistent }, req)
  }

  waf.disposeContext(req)

  Reporter.finishRequest(req, res)
}

function onRequestBodyParsed ({ req, res, body, abortController }) {
  if (body === undefined || body === null) return

  if (!req) {
    const store = storage.getStore()
    req = store?.req
  }

  const rootSpan = web.root(req)
  if (!rootSpan) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_BODY]: body
    }
  }, req)

  handleResults(results, req, res, rootSpan, abortController)
}

function onRequestQueryParsed ({ req, res, query, abortController }) {
  if (!query || typeof query !== 'object') return

  if (!req) {
    const store = storage.getStore()
    req = store?.req
  }

  const rootSpan = web.root(req)
  if (!rootSpan) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_QUERY]: query
    }
  }, req)

  handleResults(results, req, res, rootSpan, abortController)
}

function onRequestCookieParser ({ req, res, abortController, cookies }) {
  if (!cookies || typeof cookies !== 'object') return

  const rootSpan = web.root(req)
  if (!rootSpan) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_COOKIES]: cookies
    }
  }, req)

  handleResults(results, req, res, rootSpan, abortController)
}

function onResponseBody ({ req, body }) {
  if (!body || typeof body !== 'object') return
  if (!apiSecuritySampler.isSampled(req)) return

  // we don't support blocking at this point, so no results needed
  waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_RESPONSE_BODY]: body
    }
  }, req)
}

function onPassportVerify ({ credentials, user }) {
  const store = storage.getStore()
  const rootSpan = store?.req && web.root(store.req)

  if (!rootSpan) {
    log.warn('No rootSpan found in onPassportVerify')
    return
  }

  passportTrackEvent(credentials, user, rootSpan, config.appsec.eventTracking.mode)
}

const responseAnalyzedSet = new WeakSet()
const responseBlockedSet = new WeakSet()

function onResponseWriteHead ({ req, res, abortController, statusCode, responseHeaders }) {
  // avoid "write after end" error
  if (responseBlockedSet.has(res)) {
    abortController?.abort()
    return
  }

  // avoid double waf call
  if (responseAnalyzedSet.has(res)) {
    return
  }

  const rootSpan = web.root(req)
  if (!rootSpan) return

  responseHeaders = Object.assign({}, responseHeaders)
  delete responseHeaders['set-cookie']

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_RESPONSE_CODE]: '' + statusCode,
      [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: responseHeaders
    }
  }, req)

  responseAnalyzedSet.add(res)

  handleResults(results, req, res, rootSpan, abortController)
}

function handleResults (actions, req, res, rootSpan, abortController) {
  if (!actions || !req || !res || !rootSpan || !abortController) return

  const blockingAction = getBlockingAction(actions)
  if (blockingAction) {
    block(req, res, rootSpan, abortController, blockingAction)
    if (!abortController.signal || abortController.signal.aborted) {
      responseBlockedSet.add(res)
    }
  }
}

function disable () {
  isEnabled = false
  config = null

  RuleManager.clearAllRules()

  appsecTelemetry.disable()
  graphql.disable()
  rasp.disable()

  remoteConfig.disableWafUpdate()

  apiSecuritySampler.disable()

  // Channel#unsubscribe() is undefined for non active channels
  if (bodyParser.hasSubscribers) bodyParser.unsubscribe(onRequestBodyParsed)
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(incomingHttpStartTranslator)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(incomingHttpEndTranslator)
  if (queryParser.hasSubscribers) queryParser.unsubscribe(onRequestQueryParsed)
  if (cookieParser.hasSubscribers) cookieParser.unsubscribe(onRequestCookieParser)
  if (responseBody.hasSubscribers) responseBody.unsubscribe(onResponseBody)
  if (passportVerify.hasSubscribers) passportVerify.unsubscribe(onPassportVerify)
  if (responseWriteHead.hasSubscribers) responseWriteHead.unsubscribe(onResponseWriteHead)
}

module.exports = {
  enable,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
