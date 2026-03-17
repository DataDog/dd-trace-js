'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const AIGuard = require('./sdk')

const aiguardChannel = channel('dd-trace:ai:aiguard')

let isEnabled = false
let aiguard
let block

function enable (tracer, config) {
  if (isEnabled) return

  try {
    aiguard = new AIGuard(tracer, config)
    block = config.experimental?.aiguard?.block !== false

    aiguardChannel.subscribe(onEvaluate)

    isEnabled = true
  } catch (err) {
    log.error('AIGuard: unexpected error during initialization: %s', err.message)
    disable()
  }
}

function disable () {
  if (!isEnabled) return

  aiguardChannel.unsubscribe(onEvaluate)

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
