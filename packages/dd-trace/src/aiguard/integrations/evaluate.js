'use strict'

const log = require('../../log')
const { MCP_SERVERS } = require('../mcp')

/** @typedef {import('../mcp').ConversationMcp} ConversationMcp */

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
 * @param {Array<ConversationMcp|undefined>} [mcp] The MCP metadata of each conversation, by index.
 * @returns {Promise<void>|undefined} `undefined` when there is nothing to evaluate.
 */
function evaluate (interceptCtx, aiguard, conversations, opts, mcp) {
  if (!conversations?.length) return

  const parentSpan = interceptCtx?.tracingContext?.currentStore?.span
  const evaluateOpts = parentSpan ? { ...opts, childOf: parentSpan } : opts
  const evaluations = []
  let allowedCallbacks

  for (let i = 0; i < conversations.length; i++) {
    const messages = conversations[i]
    if (!messages?.length) continue

    const conversationMcp = mcp?.[i]
    if (conversationMcp) {
      allowedCallbacks ??= []
      allowedCallbacks[evaluations.length] = conversationMcp.onAllowed
      evaluations.push(evaluateOne(aiguard, messages, { ...evaluateOpts, [MCP_SERVERS]: conversationMcp.servers }))
    } else {
      evaluations.push(evaluateOne(aiguard, messages, evaluateOpts))
    }
  }

  if (evaluations.length === 0) return

  return Promise.allSettled(evaluations).then(results => {
    throwFirstBlock(results)
    if (allowedCallbacks) runAllowedCallbacks(results, allowedCallbacks)
  })
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

/**
 * Runs the callback of each evaluation that completed. It runs only when no evaluation blocked,
 * and an error in a callback never reaches the caller.
 *
 * @param {Array<{ status: string }>} results
 * @param {Array<(() => void)|undefined>} callbacks
 */
function runAllowedCallbacks (results, callbacks) {
  for (let i = 0; i < results.length; i++) {
    const callback = callbacks[i]
    if (results[i].status !== 'fulfilled' || !callback) continue

    try {
      callback()
    } catch (error) {
      log.debug('AIGuard: unable to record the evaluated MCP tool calls: %s', error.message)
    }
  }
}

module.exports = { evaluate }
