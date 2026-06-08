'use strict'

const log = require('../../log')

/**
 * Pushes one AI Guard evaluation promise into a lifecycle ctx.
 *
 * Subscribers must push synchronously during channel publication. Abort before
 * the pushed promise resolves so publishers can inspect `signal.reason` after
 * `Promise.all(ctx.pending)`.
 *
 * @param {object} ctx
 * @param {AbortController} ctx.abortController
 * @param {Array<Promise<void>>} ctx.pending
 * @param {object} aiguard
 * @param {Array<object>|undefined} messages
 * @param {object} opts
 */
function pushEvaluation (ctx, aiguard, messages, opts) {
  if (!messages?.length) return

  try {
    ctx.pending.push(aiguard.evaluate(messages, opts).catch(handleEvaluationError.bind(null, ctx)))
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

module.exports = { pushEvaluation }
