'use strict'

const log = require('../../log')

/**
 * Starts one AI Guard evaluation for a lifecycle ctx.
 *
 * Async evaluations are pushed synchronously during channel publication. If
 * evaluation throws synchronously, the error is handled before publish returns.
 *
 * @param {object} ctx
 * @param {AbortController} ctx.abortController
 * @param {object} [ctx.parentSpan]
 * @param {Array<Promise<void>>} ctx.pending
 * @param {object} aiguard
 * @param {Array<object>|undefined} messages
 * @param {object} opts
 */
function pushEvaluation (ctx, aiguard, messages, opts) {
  if (!messages?.length) return

  const evaluateOpts = ctx.parentSpan ? { ...opts, childOf: ctx.parentSpan } : opts

  try {
    ctx.pending.push(aiguard.evaluate(messages, evaluateOpts).catch(handleEvaluationError.bind(null, ctx)))
  } catch (err) {
    handleEvaluationError(ctx, err)
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
