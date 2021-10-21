'use strict'

const fs = require('fs')
const path = require('path')
const log = require('../log')
const RuleManager = require('./rule_manager')
const { INCOMING_HTTP_REQUEST_START } = require('../gateway/channels')
const Gateway = require('../gateway/engine/index')
const Addresses = require('./addresses')
const Reporter = require('./reporter')

function enable (config) {
  try {
    // TODO: enable dc_blocking: config.blocking === true

    let rules = fs.readFileSync(path.join(__dirname, 'recommended.json'))
    rules = JSON.parse(rules)

    RuleManager.applyRules(rules)

    INCOMING_HTTP_REQUEST_START.subscribe(incomingHttpTranslator)

    config.tags['_dd.appsec.enabled'] = 1
    config.tags['_dd.runtime_family'] = 'nodejs'

    // add needed fields for HTTP context reporting
    Gateway.manager.addresses.add(Addresses.HTTP_INCOMING_URL)
    Gateway.manager.addresses.add(Addresses.HTTP_INCOMING_HEADERS)
    Gateway.manager.addresses.add(Addresses.HTTP_INCOMING_METHOD)
    Gateway.manager.addresses.add(Addresses.HTTP_INCOMING_REMOTE_IP)
    Gateway.manager.addresses.add(Addresses.HTTP_INCOMING_REMOTE_PORT)

    Reporter.scheduler.start()
  } catch (err) {
    log.error(`Unable to apply AppSec rules: ${err}`)
  }
}

function incomingHttpTranslator (data) {
  const store = Gateway.startContext()

  store.set('req', data.req)
  store.set('res', data.res)

  const headers = Object.assign({}, data.req.headers)
  delete headers.cookie

  const context = store.get('context')

  Gateway.propagate({
    [Addresses.HTTP_INCOMING_URL]: data.req.url,
    [Addresses.HTTP_INCOMING_HEADERS]: headers,
    [Addresses.HTTP_INCOMING_METHOD]: data.req.method,
    // [Addresses.HTTP_INCOMING_PORT]: data.req.socket.localPort
    [Addresses.HTTP_INCOMING_REMOTE_IP]: data.req.socket.remoteAddress,
    [Addresses.HTTP_INCOMING_REMOTE_PORT]: data.req.socket.remotePort
  }, context)
}

function disable () {
  RuleManager.clearAllRules()
  if (INCOMING_HTTP_REQUEST_START.hasSubscribers) INCOMING_HTTP_REQUEST_START.unsubscribe(incomingHttpTranslator)

  const scope = global._ddtrace._tracer.scope()

  delete scope._config.tags['_dd.appsec.enabled']
  delete scope._config.tags['_dd.runtime_family']

  Reporter.scheduler.stop()
  Reporter.flush()
}

module.exports = {
  enable,
  disable,
  incomingHttpTranslator
}
