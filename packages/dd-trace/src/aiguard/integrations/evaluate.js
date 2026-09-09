'use strict'

const log = require('../../log')

/**
 * Runs one evaluation per conversation and rejects if any of them says block.
 *
 * Evaluations run concurrently and all of them are awaited, so a slow one cannot hide a block
 * from a fast one. Any failure that is not a verdict is logged and ignored, because AI Guard
 * must never break the caller.
 *
 * @param {object} interceptCtx The intercept payload, whose tracing ctx parents the span.
 * @param {object} aiguard
 * @param {Array<Array<object>>} conversations One complete message list per evaluation.
 * @param {object} opts
 * @returns {Promise<void>|undefined} `undefined` when there is nothing to evaluate.
 */
function evaluate (interceptCtx, aiguard, conversations, opts) {
  if (!conversations?.length) return

  const parentSpan = interceptCtx?.tracingContext?.currentStore?.span
  const evaluateOpts = parentSpan ? { ...opts, childOf: parentSpan } : opts
  const evaluations = []

  for (const messages of conversations) {
    if (messages?.length) evaluations.push(evaluateOne(aiguard, messages, evaluateOpts))
  }

  if (evaluations.length === 0) return

  return Promise.allSettled(evaluations).then(throwFirstBlock)
}

/**
 * Turns a synchronous throw into a rejection, so every outcome is inspected the same way.
 *
 * @param {object} aiguard
 * @param {Array<object>} messages
 * @param {object} opts
 * @returns {Promise<unknown>}
 */
function evaluateOne (aiguard, messages, opts) {
  try {
    return aiguard.evaluate(messages, opts)
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @param {Array<{ status: string, reason?: Error }>} results
 * @throws {Error} The first block verdict, if any evaluation returned one.
 */
function throwFirstBlock (results) {
  let block

  for (const result of results) {
    if (result.status === 'fulfilled') continue

    if (result.reason?.name === 'AIGuardAbortError') {
      block ??= result.reason
    } else {
      log.error('AIGuard: unexpected error during evaluation: %s', result.reason?.message)
    }
  }

  if (block) throw block
}

module.exports = { evaluate }
