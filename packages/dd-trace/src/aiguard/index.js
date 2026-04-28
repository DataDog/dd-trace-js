'use strict'

const log = require('../log')
const { incomingHttpRequestStart, openaiRequestEvaluate, vercelAiEvaluate } = require('./channels')
const AIGuard = require('./sdk')

let isEnabled = false
let aiguard
let block

function onIncomingHttpRequestStart () {
  // No-op: subscribing ensures the HTTP plugin spreads req onto the store
}

function enable (tracer, config) {
  if (isEnabled) return

  try {
    aiguard = new AIGuard(tracer, config)
    block = config.experimental?.aiguard?.block !== false

    incomingHttpRequestStart.subscribe(onIncomingHttpRequestStart)
    openaiRequestEvaluate.subscribe(onEvaluate)
    vercelAiEvaluate.subscribe(onEvaluate)

    isEnabled = true
  } catch (err) {
    log.error('AIGuard: unexpected error during initialization: %s', err.message)
    disable()
  }
}

function disable () {
  if (!isEnabled) return

  incomingHttpRequestStart.unsubscribe(onIncomingHttpRequestStart)
  openaiRequestEvaluate.unsubscribe(onEvaluate)
  vercelAiEvaluate.unsubscribe(onEvaluate)

  aiguard = undefined
  isEnabled = false
  block = false
}

/**
 * Handles channel messages with pre-converted messages.
 *
 * @param {{messages: Array<object>, resolve: Function, reject: Function}} ctx
 */
function onEvaluate (ctx) {
  if (!ctx.messages?.length) {
    ctx.resolve()
    return
  }

  aiguard.evaluate(ctx.messages, { block })
    .then(() => {
      ctx.resolve()
    })
    .catch(err => {
      if (err.name === 'AIGuardAbortError') {
        ctx.reject(err)
      } else {
        log.error('AIGuard: unexpected error during evaluation: %s', err.message)
        ctx.resolve()
      }
    })
}

module.exports = { enable, disable }
