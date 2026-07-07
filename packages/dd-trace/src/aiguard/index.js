'use strict'

const log = require('../log')
const { incomingHttpRequestStart } = require('./channels')
const integrations = require('./integrations')
const AIGuard = require('./sdk')

let isEnabled = false
let aiguard

function onIncomingHttpRequestStart () {
  // No-op: subscribing ensures the HTTP plugin spreads req onto the store
}

function enable (tracer, config) {
  if (isEnabled) return

  try {
    aiguard = new AIGuard(tracer, config)
    const block = config.experimental?.aiguard?.block !== false

    incomingHttpRequestStart.subscribe(onIncomingHttpRequestStart)
    integrations.enable(aiguard, block)

    isEnabled = true
  } catch (err) {
    log.error('AIGuard: unexpected error during initialization: %s', err.message)
    reset()
  }
}

function disable () {
  if (!isEnabled) return

  reset()
}

function reset () {
  incomingHttpRequestStart.unsubscribe(onIncomingHttpRequestStart)
  integrations.disable()

  aiguard = undefined
  isEnabled = false
}

module.exports = { enable, disable }
