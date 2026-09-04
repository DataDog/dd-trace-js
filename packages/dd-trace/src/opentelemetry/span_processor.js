'use strict'

const getFlushError = require('../flush-error')

/**
 * @typedef {{ status: 'fulfilled', value: unknown } | { status: 'rejected', reason: unknown }} FlushResult
 */

/**
 * @param {FlushResult[]} results
 * @returns {Promise<void> | undefined}
 */
function collectFlushErrors (results) {
  const reasons = []
  for (const result of results) {
    if (result.status !== 'rejected') continue
    reasons.push(result.reason)
  }

  if (reasons.length > 0) return Promise.reject(getFlushError(reasons))
}

/**
 * @param {Promise<unknown>[]} flushes
 * @returns {Promise<void>}
 */
function settleAllFlushes (flushes) {
  return Promise.allSettled(flushes).then(collectFlushErrors)
}

class NoopSpanProcessor {
  forceFlush () {
    return Promise.resolve()
  }

  onStart (span, context) {}
  onEnd (span) {}

  shutdown () {
    return Promise.resolve()
  }
}

class MultiSpanProcessor extends NoopSpanProcessor {
  #processors

  constructor (spanProcessors) {
    super()
    this.#processors = spanProcessors
  }

  forceFlush () {
    const flushes = []
    for (const processor of this.#processors) flushes.push(processor.forceFlush())
    return settleAllFlushes(flushes)
  }

  onStart (span, context) {
    for (const processor of this.#processors) {
      processor.onStart(span, context)
    }
  }

  onEnd (span) {
    for (const processor of this.#processors) {
      processor.onEnd(span)
    }
  }

  shutdown () {
    return Promise.all(
      this.#processors.map(p => p.shutdown())
    )
  }
}

module.exports = {
  MultiSpanProcessor,
  NoopSpanProcessor,
  settleAllFlushes,
}
