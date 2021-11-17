'use strict'

const fs = require('fs')
const path = require('path')
const log = require('../log')
const RuleManager = require('./rule_manager')
const { INCOMING_HTTP_REQUEST_START } = require('../gateway/channels')
const Gateway = require('../gateway/engine/index')
const addresses = require('./addresses')
const Reporter = require('./reporter')

function enable (config) {
  try {
    // TODO: enable dc_blocking: config.blocking === true

    let rules = fs.readFileSync(path.join(__dirname, 'recommended.json'))
    rules = JSON.parse(rules)

    RuleManager.applyRules(rules)
  } catch (err) {
    log.error(`Unable to apply AppSec rules: ${err}`)

    // abort AppSec start
    RuleManager.clearAllRules()
    return
  }

  INCOMING_HTTP_REQUEST_START.subscribe(incomingHttpTranslator)

  config.tags['_dd.appsec.enabled'] = 1
  config.tags['_dd.runtime_family'] = 'nodejs'

  // add needed fields for HTTP context reporting
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_URL)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_HEADERS)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_METHOD)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_REMOTE_IP)
  Gateway.manager.addresses.add(addresses.HTTP_INCOMING_REMOTE_PORT)

  Reporter.scheduler.start()
}

function incomingHttpTranslator (data) {
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

function disable () {
  RuleManager.clearAllRules()
  if (INCOMING_HTTP_REQUEST_START.hasSubscribers) INCOMING_HTTP_REQUEST_START.unsubscribe(incomingHttpTranslator)

  const tags = global._ddtrace._tracer._tags

  delete tags['_dd.appsec.enabled']
  delete tags['_dd.runtime_family']

  Reporter.scheduler.stop()
  Reporter.flush()
}

module.exports = {
  enable,
  disable,
  incomingHttpTranslator
}
