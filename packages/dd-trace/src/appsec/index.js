'use strict'

const fs = require('fs')
const path = require('path')
const log = require('../log')
const RuleManager = require('./rule_manager')
const { INCOMING_HTTP_REQUEST_START } = require('../gateway/channels')
const { startContext } = require('../gateway/engine/index')
const Addresses = require('./addresses')

function enable (config) {
  try {
    // TODO: enable dc_blocking: config.blocking === true

    let rules = fs.readFileSync(path.join(__dirname, 'recommended.json'))
    rules = JSON.parse(rules)

    RuleManager.applyRules(rules)

    INCOMING_HTTP_REQUEST_START.subscribe(incomingHttpTranslator)
  } catch (err) {
    log.error(`Unable to apply AppSec rules: ${err}`)
  }
}

function incomingHttpTranslator (data) {
  const store = startContext()

  store.set('req', data.req)
  store.set('res', data.res)

  const context = store.get('context')

  context.setValue(Addresses.HTTP_INCOMING_URL, data.req.url)

  const headers = Object.assign({}, data.req.headers)
  delete headers.cookie
  context.setValue(Addresses.HTTP_INCOMING_HEADERS, headers)

  context.dispatch()
}

function disable () {
  RuleManager.clearAllRules()
  INCOMING_HTTP_REQUEST_START.unsubscribe(incomingHttpTranslator)
}

module.exports = {
  enable,
  disable
}
