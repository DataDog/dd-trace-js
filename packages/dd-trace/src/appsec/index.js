'use strict'

const dc = require('diagnostics_channel')
const fs = require('fs')
const path = require('path')
const log = require('../log')
const RuleManager = require('./rule_manager')
const remoteConfig = require('./remote_config')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('./gateway/channels')
const Gateway = require('./gateway/engine')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const web = require('../plugins/util/web')
const { extractIp } = require('../plugins/util/ip_extractor')
const { HTTP_CLIENT_IP } = require('../../../../ext/tags')
const { block, loadTemplates, loadTemplatesAsync } = require('./blocking')

const bodyParserChannel = dc.channel('datadog:body-parser:read:finish')
const cookieParserChannel = dc.channel('datadog:cookie-parser:read:finish')
const queryParserChannel = dc.channel('datadog:query:read:finish')

let isEnabled = false
let config

function enable (_config) {
  if (isEnabled) return

  try {
    loadTemplates(_config)
    const rules = fs.readFileSync(_config.appsec.rules || path.join(__dirname, 'recommended.json'))
    enableFromRules(_config, JSON.parse(rules))
  } catch (err) {
    abortEnable(err)
  }
}

async function enableAsync (_config) {
  if (isEnabled) return

  try {
    await loadTemplatesAsync(_config)
    const rules = await fs.promises.readFile(_config.appsec.rules || path.join(__dirname, 'recommended.json'))
    enableFromRules(_config, JSON.parse(rules))
  } catch (err) {
    abortEnable(err)
  }
}

function enableFromRules (_config, rules) {
  RuleManager.applyRules(rules, _config.appsec)
  remoteConfig.enableAsmData(_config.appsec)

  Reporter.setRateLimit(_config.appsec.rateLimit)

  incomingHttpRequestStart.subscribe(incomingHttpStartTranslator)
  incomingHttpRequestEnd.subscribe(incomingHttpEndTranslator)
  bodyParserChannel.subscribe(onRequestBodyParsed)
  cookieParserChannel.subscribe(onRequestCookieParsed)
  queryParserChannel.subscribe(onRequestQueryParsed)

  // add fields needed for HTTP context reporting
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_HEADERS)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_ENDPOINT)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_RESPONSE_HEADERS)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_REMOTE_IP)

  isEnabled = true
  config = _config
}

function abortEnable (err) {
  log.error('Unable to start AppSec')
  log.error(err)

  // abort AppSec start
  RuleManager.clearAllRules()
  remoteConfig.disableAsmData()
}

function incomingHttpStartTranslator ({ req, res, abortController }) {
  const topSpan = web.root(req)
  if (!topSpan) return

  const clientIp = extractIp(config, req)

  topSpan.addTags({
    '_dd.appsec.enabled': 1,
    '_dd.runtime_family': 'nodejs',
    [HTTP_CLIENT_IP]: clientIp
  })

  const store = Gateway.startContext()

  store.set('req', req)
  store.set('res', res)

  const context = store.get('context')

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

  const results = Gateway.propagate(payload, context)

  handleResults(results, req, res, topSpan, abortController)
}

function incomingHttpEndTranslator (data) {
  const context = Gateway.getContext()
  if (!context) return

  // TODO: this doesn't support headers sent with res.writeHead()
  const responseHeaders = Object.assign({}, data.res.getHeaders())
  delete responseHeaders['set-cookie']

  const payload = {
    [addresses.HTTP_INCOMING_RESPONSE_CODE]: data.res.statusCode,
    [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: responseHeaders
  }

  // TODO: temporary express instrumentation, will use express plugin later
  if (data.req.query && typeof data.req.query === 'object') {
    payload[addresses.HTTP_INCOMING_QUERY] = data.req.query
  }

  if (data.req.route && typeof data.req.route.path === 'string') {
    payload[addresses.HTTP_INCOMING_ENDPOINT] = data.req.route.path
  }

  if (data.req.params && typeof data.req.params === 'object') {
    payload[addresses.HTTP_INCOMING_PARAMS] = data.req.params
  }

  Gateway.propagate(payload, context)

  Reporter.finishRequest(data.req, context)
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

function getCookiesPayload (req) {
  if (req.cookies && typeof req.cookies === 'object') {
    const incomingCookiesPayload = {}

    for (const k of Object.keys(req.cookies)) {
      incomingCookiesPayload[k] = [req.cookies[k]]
    }

    return { [addresses.HTTP_INCOMING_COOKIES]: incomingCookiesPayload }
  }
  return null
}

function onRequestCookieParsed (channelData) {
  checkRequestData(channelData, getCookiesPayload(channelData.req))
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
    const context = Gateway.getContext()
    if (!context) return

    const rootSpan = web.root(req)
    if (!rootSpan) return

    const results = Gateway.propagate(payload, context)

    handleResults(results, req, res, rootSpan, abortController)
  }
}

function disable () {
  isEnabled = false
  config = null

  RuleManager.clearAllRules()
  remoteConfig.disableAsmData()

  // Channel#unsubscribe() is undefined for non active channels
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(incomingHttpStartTranslator)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(incomingHttpEndTranslator)
  if (bodyParserChannel.hasSubscribers) bodyParserChannel.unsubscribe(onRequestBodyParsed)
  if (cookieParserChannel.hasSubscribers) cookieParserChannel.unsubscribe(onRequestCookieParsed)
  if (queryParserChannel.hasSubscribers) queryParserChannel.unsubscribe(onRequestQueryParsed)
}

function handleResults (results, req, res, topSpan, abortController) {
  if (!results || !req || !res || !topSpan || !abortController) return

  for (const entry of results) {
    if (entry && entry.includes('block')) {
      block(req, res, topSpan, abortController)
      break
    }
  }
}

module.exports = {
  enable,
  enableAsync,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
