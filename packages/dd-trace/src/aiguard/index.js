'use strict'

const log = require('../log')
const { incomingHttpRequestStart } = require('./channels')
const openaiIntegration = require('./integrations/openai')
const vercelAiIntegration = require('./integrations/vercel-ai')
const AIGuard = require('./sdk')

let isEnabled = false
let aiguard
let block
let disableOpenAIIntegration
let disableVercelAiIntegration

function onIncomingHttpRequestStart () {
  // No-op: subscribing ensures the HTTP plugin spreads req onto the store
}

function enable (tracer, config) {
  if (isEnabled) return

  try {
    aiguard = new AIGuard(tracer, config)
    block = config.experimental?.aiguard?.block !== false

    incomingHttpRequestStart.subscribe(onIncomingHttpRequestStart)
    disableOpenAIIntegration = openaiIntegration.enable(aiguard, block)
    disableVercelAiIntegration = vercelAiIntegration.enable(aiguard, block)

    isEnabled = true
  } catch (err) {
    log.error('AIGuard: unexpected error during initialization: %s', err.message)
    disable()
  }
}

function disable () {
  if (!isEnabled) return

  incomingHttpRequestStart.unsubscribe(onIncomingHttpRequestStart)
  disableOpenAIIntegration?.()
  disableVercelAiIntegration?.()

  aiguard = undefined
  isEnabled = false
  block = false
  disableOpenAIIntegration = undefined
  disableVercelAiIntegration = undefined
}

module.exports = { enable, disable }
