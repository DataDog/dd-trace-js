'use strict'

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
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const clientIp = extractIp(config, req)

  rootSpan.addTags({
    '_dd.appsec.enabled': 1,
    '_dd.runtime_family': 'nodejs',
    [HTTP_CLIENT_IP]: clientIp
  })

  const store = Gateway.startContext()

  store.set('req', req)
  store.set('res', res)

  const context = store.get('context')

  if (clientIp) {
    const results = Gateway.propagate({
      [addresses.HTTP_CLIENT_IP]: clientIp
    }, context)

    if (!results || !abortController) return

    for (const entry of results) {
      if (entry && entry.includes('block')) {
        block(req, res, rootSpan, abortController)
        break
      }
    }
  }
}

function incomingHttpEndTranslator (data) {
  const context = Gateway.getContext()
  if (!context) return

  const requestHeaders = Object.assign({}, data.req.headers)
  delete requestHeaders.cookie

  // TODO: this doesn't support headers sent with res.writeHead()
  const responseHeaders = Object.assign({}, data.res.getHeaders())
  delete responseHeaders['set-cookie']

  const payload = {
    [addresses.HTTP_INCOMING_URL]: data.req.url,
    [addresses.HTTP_INCOMING_HEADERS]: requestHeaders,
    [addresses.HTTP_INCOMING_METHOD]: data.req.method,
    [addresses.HTTP_INCOMING_REMOTE_IP]: data.req.socket.remoteAddress,
    [addresses.HTTP_INCOMING_REMOTE_PORT]: data.req.socket.remotePort,
    [addresses.HTTP_INCOMING_RESPONSE_CODE]: data.res.statusCode,
    [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: responseHeaders
  }

  // TODO: temporary express instrumentation, will use express plugin later
  if (data.req.body !== undefined && data.req.body !== null) {
    payload[addresses.HTTP_INCOMING_BODY] = data.req.body
  }

  if (data.req.query && typeof data.req.query === 'object') {
    payload[addresses.HTTP_INCOMING_QUERY] = data.req.query
  }

  if (data.req.route && typeof data.req.route.path === 'string') {
    payload[addresses.HTTP_INCOMING_ENDPOINT] = data.req.route.path
  }

  if (data.req.params && typeof data.req.params === 'object') {
    payload[addresses.HTTP_INCOMING_PARAMS] = data.req.params
  }

  if (data.req.cookies && typeof data.req.cookies === 'object') {
    payload[addresses.HTTP_INCOMING_COOKIES] = {}

    for (const k of Object.keys(data.req.cookies)) {
      payload[addresses.HTTP_INCOMING_COOKIES][k] = [data.req.cookies[k]]
    }
  }

  Gateway.propagate(payload, context)

  Reporter.finishRequest(data.req, context)
}

function disable () {
  isEnabled = false
  config = null

  RuleManager.clearAllRules()
  remoteConfig.disableAsmData()

  // Channel#unsubscribe() is undefined for non active channels
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(incomingHttpStartTranslator)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(incomingHttpEndTranslator)
}

module.exports = {
  enable,
  enableAsync,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
