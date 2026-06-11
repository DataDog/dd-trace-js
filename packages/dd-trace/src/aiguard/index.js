'use strict'

const log = require('../log')
const { incomingHttpRequestStart, aiguardChannel } = require('./channels')
const AIGuard = require('./sdk')
const { SOURCE_AUTO, INTEGRATION_NONE } = require('./tags')

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
    aiguardChannel.subscribe(onEvaluate)

    isEnabled = true
  } catch (err) {
    log.error('AIGuard: unexpected error during initialization: %s', err.message)
    disable()
  }
}

function disable () {
  if (!isEnabled) return

  incomingHttpRequestStart.unsubscribe(onIncomingHttpRequestStart)
  aiguardChannel.unsubscribe(onEvaluate)

  aiguard = undefined
  isEnabled = false
  block = false
}

/**
 * Handles channel messages with pre-converted messages.
 *
 * @param {object} ctx
 * @param {Array<object>} ctx.messages
 * @param {string} [ctx.integration]
 * @param {object} [ctx.parentSpan] - LLM span to parent the `ai_guard` span under.
 * @param {AbortController} ctx.abortController
 * @param {Array<Promise<void>>} ctx.pending - Subscribers push only when they evaluate.
 */
function onEvaluate (ctx) {
  // Decline to evaluate empty payloads by not pushing to pending.
  if (!ctx.messages?.length) {
    return
  }

  const opts = {
    block,
    source: SOURCE_AUTO,
    integration: ctx.integration || INTEGRATION_NONE,
    childOf: ctx.parentSpan,
  }

  try {
    ctx.pending.push(aiguard.evaluate(ctx.messages, opts).catch(handleEvaluationError.bind(null, ctx)))
  } catch (err) {
    ctx.pending.push(Promise.resolve().then(() => handleEvaluationError(ctx, err)))
  }
}

/**
 * Handles an AI Guard evaluation failure.
 *
 * @param {object} ctx
 * @param {AbortController} ctx.abortController
 * @param {Error} err
 */
function handleEvaluationError (ctx, err) {
  if (err.name === 'AIGuardAbortError') {
    ctx.abortController.abort(err)
  } else {
    log.error('AIGuard: unexpected error during evaluation: %s', err.message)
  }
}

module.exports = { enable, disable }
