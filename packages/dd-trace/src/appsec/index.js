'use strict'

const fs = require('fs')
const log = require('../log')
const RuleManager = require('./rule_manager')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('./gateway/channels')
const Gateway = require('./gateway/engine')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const web = require('../plugins/util/web')

function enable (config) {
  try {
    // TODO: enable dc_blocking: config.appsec.blocking === true

    let rules = fs.readFileSync(config.appsec.rules)
    rules = JSON.parse(rules)

    RuleManager.applyRules(rules, config.appsec)
  } catch (err) {
    log.error('Unable to start AppSec')
    log.error(err)

    // abort AppSec start
    RuleManager.clearAllRules()
    return
  }

  Reporter.setRateLimit(config.appsec.rateLimit)

  incomingHttpRequestStart.subscribe(incomingHttpStartTranslator)
  incomingHttpRequestEnd.subscribe(incomingHttpEndTranslator)

  // add fields needed for HTTP context reporting
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_HEADERS)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_ENDPOINT)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_RESPONSE_HEADERS)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_REMOTE_IP)
}

function incomingHttpStartTranslator (data) {
  // TODO: get span from datadog-core storage instead
  // TODO: run WAF and potentially block here
  const topSpan = web.root(data.req)
  if (!topSpan) {
    return
  }
  topSpan.addTags({
    '_dd.appsec.enabled': 1,
    '_dd.runtime_family': 'nodejs'
  })
  const store = Gateway.startContext()
  store.set('req', data.req)
  store.set('res', data.res)
  const context = store.get('context')
  const requestHeaders = Object.assign({}, data.req.headers)
  delete requestHeaders.cookie // cookies will be parsed, let's do them at framework level
  const payload = {
    [addresses.HTTP_INCOMING_URL]: data.req.url,
    [addresses.HTTP_INCOMING_HEADERS]: requestHeaders,
    [addresses.HTTP_INCOMING_METHOD]: data.req.method,
    [addresses.HTTP_INCOMING_REMOTE_IP]: data.req.socket.remoteAddress,
    [addresses.HTTP_INCOMING_REMOTE_PORT]: data.req.socket.remotePort
  }

  if (context.needsAddress(addresses.HTTP_CLIENT_IP)) {
    payload[addresses.HTTP_CLIENT_IP] = web.extractIp({ req: data.req, config: data.config })
  }

  const results = Gateway.propagate(payload, context)
  let block = false
  for (const entry of results) {
    block = block || (entry.actions && entry.actions.includes('block'))
  }
  if (block) {
    data.abort()
  }
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
      payload[addresses.HTTP_INCOMING_COOKIES][k] = [ data.req.cookies[k] ]
    }
  }

  Gateway.propagate(payload, context)

  Reporter.finishRequest(data.req, context)
}

function disable () {
  RuleManager.clearAllRules()

  // Channel#unsubscribe() is undefined for non active channels
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(incomingHttpStartTranslator)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(incomingHttpEndTranslator)
}

module.exports = {
  enable,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
