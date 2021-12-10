'use strict'

const fs = require('fs')
const log = require('../log')
const RuleManager = require('./rule_manager')
const { INCOMING_HTTP_REQUEST_START, INCOMING_HTTP_REQUEST_END } = require('../gateway/channels')
const Gateway = require('../gateway/engine/index')
const addresses = require('./addresses')
const Reporter = require('./reporter')

function enable (config) {
  try {
    // TODO: enable dc_blocking: config.appsec.blocking === true

    let rules = fs.readFileSync(config.appsec.rules)
    rules = JSON.parse(rules)

    RuleManager.applyRules(rules)
  } catch (err) {
    log.error(`Unable to apply AppSec rules: ${err}`)

    // abort AppSec start
    RuleManager.clearAllRules()
    return
  }

  INCOMING_HTTP_REQUEST_START.subscribe(incomingHttpStartTranslator)
  INCOMING_HTTP_REQUEST_END.subscribe(incomingHttpEndTranslator)

  config.tags['_dd.appsec.enabled'] = 1
  config.tags['_dd.runtime_family'] = 'nodejs'

  // add needed fields for HTTP context reporting
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_URL)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_HEADERS)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_METHOD)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_REMOTE_IP)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_REMOTE_PORT)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_RESPONSE_CODE)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_RESPONSE_HEADERS)
}

function incomingHttpStartTranslator (data) {
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

  Gateway.propagate({
    [addresses.HTTP_INCOMING_RESPONSE_CODE]: data.res.statusCode,
    [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: headers
  }, context)

  Reporter.finishAttacks(data.req, context)
}

function disable () {
  RuleManager.clearAllRules()

  if (INCOMING_HTTP_REQUEST_START.hasSubscribers) INCOMING_HTTP_REQUEST_START.unsubscribe(incomingHttpStartTranslator)
  if (INCOMING_HTTP_REQUEST_END.hasSubscribers) INCOMING_HTTP_REQUEST_END.unsubscribe(incomingHttpEndTranslator)

  const tags = global._ddtrace._tracer._tags

  delete tags['_dd.appsec.enabled']
  delete tags['_dd.runtime_family']
}

module.exports = {
  enable,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
