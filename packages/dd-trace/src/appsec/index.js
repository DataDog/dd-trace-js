'use strict'

const dc = require('../../../diagnostics_channel')
const log = require('../log')
const RuleManager = require('./rule_manager')
const remoteConfig = require('./remote_config')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('./channels')
const waf = require('./waf')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const web = require('../plugins/util/web')
const { extractIp } = require('../plugins/util/ip_extractor')
const { HTTP_CLIENT_IP } = require('../../../../ext/tags')
const { block, setTemplates } = require('./blocking')

const bodyParserChannel = dc.channel('datadog:body-parser:read:finish')
const queryParserChannel = dc.channel('datadog:query:read:finish')

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
    bodyParserChannel.subscribe(onRequestBodyParsed)
    queryParserChannel.subscribe(onRequestQueryParsed)

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
    [addresses.HTTP_INCOMING_METHOD]: req.method,
    [addresses.HTTP_INCOMING_REMOTE_IP]: req.socket.remoteAddress,
    [addresses.HTTP_INCOMING_REMOTE_PORT]: req.socket.remotePort
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

function getBodyPayload (req) {
  if (req.body !== undefined && req.body !== null) {
    return {
      [addresses.HTTP_INCOMING_BODY]: req.body
    }
  }
  return null
}

function onRequestBodyParsed (channelData) {
  checkRequestData(channelData, getBodyPayload(channelData.req))
}

function getQueryPayload (req) {
  if (req.query && typeof req.query === 'object') {
    return {
      [addresses.HTTP_INCOMING_QUERY]: req.query
    }
  }
  return null
}

function onRequestQueryParsed (channelData) {
  checkRequestData(channelData, getQueryPayload(channelData.req))
}

function checkRequestData ({ req, res, abortController }, payload) {
  if (payload) {
    const rootSpan = web.root(req)
    if (!rootSpan) return

    const results = waf.run(payload, req)

    handleResults(results, req, res, rootSpan, abortController)
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
  if (bodyParserChannel.hasSubscribers) bodyParserChannel.unsubscribe(onRequestBodyParsed)
  if (queryParserChannel.hasSubscribers) queryParserChannel.unsubscribe(onRequestQueryParsed)
}

function handleResults (actions, req, res, rootSpan, abortController) {
  if (!actions || !req || !res || !rootSpan || !abortController) return

  if (actions.includes('block')) {
    block(req, res, rootSpan, abortController)
  }
}

module.exports = {
  enable,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
