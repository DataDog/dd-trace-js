'use strict'

const log = require('../log')
const RuleManager = require('./rule_manager')
const remoteConfig = require('./remote_config')
const {
  incomingHttpRequestStart,
  incomingHttpRequestEnd,
  bodyParser,
  passportVerify,
  queryParser
} = require('./channels')
const waf = require('./waf')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const web = require('../plugins/util/web')
const { extractIp } = require('../plugins/util/ip_extractor')
const { HTTP_CLIENT_IP } = require('../../../../ext/tags')
const { block, setTemplates } = require('./blocking')
const { passportTrackEvent } = require('./passport')
const { storage } = require('../../../datadog-core')

let isEnabled = false
let config

function enable (_config) {
  if (isEnabled) return

  try {
    setTemplates(_config)

    RuleManager.applyRules(_config.appsec.rules, _config.appsec)

    remoteConfig.enableWafUpdate(_config.appsec)

    Reporter.setRateLimit(_config.appsec.rateLimit)

    incomingHttpRequestStart.subscribe(incomingHttpStartTranslator)
    incomingHttpRequestEnd.subscribe(incomingHttpEndTranslator)
    bodyParser.subscribe(onRequestBodyParsed)
    queryParser.subscribe(onRequestQueryParsed)

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

  const payload = {
    [addresses.HTTP_INCOMING_URL]: req.url,
    [addresses.HTTP_INCOMING_HEADERS]: requestHeaders,
    [addresses.HTTP_INCOMING_METHOD]: req.method
  }

  if (clientIp) {
    payload[addresses.HTTP_CLIENT_IP] = clientIp
  }

  const actions = waf.run(payload, req)

  handleResults(actions, req, res, rootSpan, abortController)
}

function incomingHttpEndTranslator ({ req, res }) {
  // TODO: this doesn't support headers sent with res.writeHead()
  const responseHeaders = Object.assign({}, res.getHeaders())
  delete responseHeaders['set-cookie']

  const payload = {
    [addresses.HTTP_INCOMING_RESPONSE_CODE]: res.statusCode,
    [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: responseHeaders
  }

  // we need to keep this to support other body parsers
  // TODO: no need to analyze it if it was already done by the body-parser hook
  if (req.body !== undefined && req.body !== null) {
    payload[addresses.HTTP_INCOMING_BODY] = req.body
  }

  // TODO: temporary express instrumentation, will use express plugin later
  if (req.params && typeof req.params === 'object') {
    payload[addresses.HTTP_INCOMING_PARAMS] = req.params
  }

  if (req.cookies && typeof req.cookies === 'object') {
    payload[addresses.HTTP_INCOMING_COOKIES] = {}

    for (const k of Object.keys(req.cookies)) {
      payload[addresses.HTTP_INCOMING_COOKIES][k] = [req.cookies[k]]
    }
  }

  waf.run(payload, req)

  waf.disposeContext(req)

  Reporter.finishRequest(req, res)
}

function onRequestBodyParsed ({ req, res, abortController }) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (req.body === undefined || req.body === null) return

  const results = waf.run({
    [addresses.HTTP_INCOMING_BODY]: req.body
  }, req)

  handleResults(results, req, res, rootSpan, abortController)
}

function onRequestQueryParsed ({ req, res, abortController }) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (!req.query || typeof req.query !== 'object') return

  const results = waf.run({
    [addresses.HTTP_INCOMING_QUERY]: req.query
  }, req)

  handleResults(results, req, res, rootSpan, abortController)
}

function onPassportVerify ({ credentials, user }) {
  const store = storage.getStore()
  const rootSpan = store && store.req && web.root(store.req)

  if (!rootSpan) {
    log.warn('No rootSpan found in onPassportVerify')
    return
  }

  passportTrackEvent(credentials, user, rootSpan, config.appsec.eventTracking.mode)
}

function handleResults (actions, req, res, rootSpan, abortController) {
  if (!actions || !req || !res || !rootSpan || !abortController) return

  if (actions.includes('block')) {
    block(req, res, rootSpan, abortController)
  }
}

function disable () {
  isEnabled = false
  config = null

  RuleManager.clearAllRules()

  remoteConfig.disableWafUpdate()

  // Channel#unsubscribe() is undefined for non active channels
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(incomingHttpStartTranslator)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(incomingHttpEndTranslator)
  if (bodyParser.hasSubscribers) bodyParser.unsubscribe(onRequestBodyParsed)
  if (queryParser.hasSubscribers) queryParser.unsubscribe(onRequestQueryParsed)
  if (passportVerify.hasSubscribers) passportVerify.unsubscribe(onPassportVerify)
}

module.exports = {
  enable,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
