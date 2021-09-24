'use strict'

const fs = require('fs')
const path = require('path')
const log = require('../log')
const RuleManager = require('./rule_manager')
const { INCOMING_HTTP_REQUEST_START } = require('../gateway/channels')
const { startContext, propagate } = require('../gateway/engine/index')
const Addresses = require('./addresses')

function enable (config) {
  try {
    // TODO: enable dc_blocking: config.blocking === true

    let rules = fs.readFileSync(path.join(__dirname, 'recommended.json'))
    rules = JSON.parse(rules)

    RuleManager.applyRules(rules)

    INCOMING_HTTP_REQUEST_START.subscribe(incomingHttpTranslator)

    config.tags['_dd.appsec.enabled'] = 1
    config.tags['_dd.runtime_family'] = 'nodejs'
  } catch (err) {
    log.error(`Unable to apply AppSec rules: ${err}`)
  }
}

function incomingHttpTranslator (data) {
  const store = startContext()

  store.set('req', data.req)
  store.set('res', data.res)

  const headers = Object.assign({}, data.req.headers)
  delete headers.cookie

  const context = store.get('context')

  propagate({
    [Addresses.HTTP_INCOMING_URL]: data.req.url,
    [Addresses.HTTP_INCOMING_HEADERS]: headers
  }, context)
}

function disable () {
  RuleManager.clearAllRules()
  INCOMING_HTTP_REQUEST_START.unsubscribe(incomingHttpTranslator)

  const scope = global._ddtrace.scope()

  delete scope._config.tags['_dd.appsec.enabled']
  delete scope._config.tags['_dd.runtime_family']
}

module.exports = {
  enable,
  disable
}
