'use strict'

const fs = require('fs')
const log = require('../log')
const RuleManager = require('./rule_manager')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('./gateway/channels')
const Gateway = require('./gateway/engine')
const addresses = require('./addresses')
const Reporter = require('./reporter')

function enable (config) {
  try {
    // TODO: enable dc_blocking: config.appsec.blocking === true

    let rules = fs.readFileSync(config.appsec.rules)
    rules = JSON.parse(rules)

    RuleManager.applyRules(rules)
  } catch (err) {
    log.error('Unable to start AppSec')
    log.error(err)

    // abort AppSec start
    RuleManager.clearAllRules()
    return
  }

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
  const topSpan = data.req._datadog && data.req._datadog.span
  if (topSpan) {
    topSpan.addTags({
      '_dd.appsec.enabled': 1,
      '_dd.runtime_family': 'nodejs'
    })
  }

  const store = Gateway.startContext()

  store.set('req', data.req)
  store.set('res', data.res)

  const headers = Object.assign({}, data.req.headers)
  delete headers.cookie

  const context = store.get('context')

  Gateway.propagate({
    [addresses.HTTP_INCOMING_URL]: data.req.url,
    [addresses.HTTP_INCOMING_HEADERS]: headers,
    [addresses.HTTP_INCOMING_METHOD]: data.req.method,
    [addresses.HTTP_INCOMING_REMOTE_IP]: data.req.socket.remoteAddress,
    [addresses.HTTP_INCOMING_REMOTE_PORT]: data.req.socket.remotePort
  }, context)
}

function incomingHttpEndTranslator (data) {
  const context = Gateway.getContext()

  if (!context) return

  // TODO: this doesn't support headers sent with res.writeHead()
  const headers = Object.assign({}, data.res.getHeaders())
  delete headers['set-cookie']

  const payload = {
    [addresses.HTTP_INCOMING_RESPONSE_CODE]: data.res.statusCode,
    [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: headers
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

  if (data.req.cookies && typeof data.req.cookies === 'object') {
    payload[addresses.HTTP_INCOMING_COOKIES] = data.req.cookies
  }

  Gateway.propagate(payload, context)

  Reporter.finishAttacks(data.req, context)
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
