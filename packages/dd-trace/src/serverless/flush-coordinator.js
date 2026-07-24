'use strict'

const channels = require('./channels')

const OUTCOME_DISABLED = 'disabled'
const OUTCOME_HANDED_OFF = 'handed_off'
const OUTCOME_EMPTY = 'empty'
const OUTCOME_FAILED = 'failed'
const OUTCOME_TIMED_OUT = 'timed_out'

function noop () {}

class FlushCoordinator {
  /**
   * @param {object} tracer Internal tracer instance.
   * @param {object} [options]
   * @param {Function} [options.isEmpty] Returns true when there is no buffered trace work to flush.
   */
  constructor (tracer, options = {}) {
    this._tracer = tracer
    this._isEmpty = options.isEmpty
  }

  /**
   * Flush pending trace data and report a truthful handoff outcome.
   *
   * Exporter completion means the trace was handed to its configured transport.
   * It does not prove that a local agent delivered the trace to Datadog.
   *
   * @param {object} options
   * @param {number} [options.deadlineMs] Absolute timestamp by which flushing should finish.
   * @param {string} [options.reason] Invocation phase that requested the flush.
   * @param {unknown} [options.token] Opaque invocation token.
   * @param {object} [options.source] Source metadata for the platform adapter.
   * @param {Function} [done] Callback invoked with the flush result.
   * @returns {void}
   */
  flush (options = {}, done = noop) {
    const resultBase = {
      reason: options.reason,
      token: options.token,
      source: options.source,
    }

    channels.flushStart.publish(resultBase)

    if (this._isEmpty && this._isEmpty()) {
      return this._finish(OUTCOME_EMPTY, resultBase, done)
    }

    const exporter = this._tracer?._exporter
    if (!exporter || typeof exporter.flush !== 'function') {
      return this._finish(OUTCOME_DISABLED, resultBase, done)
    }

    let settled = false
    let timer

    const timeoutMs = getTimeoutMs(options.deadlineMs)
    if (timeoutMs !== undefined) {
      if (timeoutMs <= 0) {
        return this._finish(OUTCOME_TIMED_OUT, resultBase, done)
      }

      timer = setTimeout(() => {
        finish(OUTCOME_TIMED_OUT)
      }, timeoutMs)
      timer.unref?.()
    }

    const finish = (outcome, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      this._finish(outcome, resultBase, done, error)
    }

    try {
      exporter.flush(error => {
        finish(error ? OUTCOME_FAILED : OUTCOME_HANDED_OFF, error)
      })
    } catch (error) {
      finish(OUTCOME_FAILED, error)
    }
  }

  /**
   * Publish the terminal flush outcome and notify the caller.
   *
   * @param {string} outcome Flush outcome.
   * @param {object} resultBase Shared result fields.
   * @param {Function} done Completion callback.
   * @param {Error} [error] Flush failure.
   * @returns {void}
   */
  _finish (outcome, resultBase, done, error) {
    const result = {
      ...resultBase,
      outcome,
      error,
    }

    getOutcomeChannel(outcome).publish(result)
    done(result)
  }
}

function getTimeoutMs (deadlineMs) {
  if (typeof deadlineMs === 'number') return deadlineMs - Date.now()
}

function getOutcomeChannel (outcome) {
  switch (outcome) {
    case OUTCOME_HANDED_OFF:
      return channels.flushHandedOff
    case OUTCOME_EMPTY:
      return channels.flushEmpty
    case OUTCOME_FAILED:
      return channels.flushFailed
    case OUTCOME_TIMED_OUT:
      return channels.flushTimedOut
    default:
      return channels.flushDisabled
  }
}

module.exports = {
  FlushCoordinator,
  OUTCOME_DISABLED,
  OUTCOME_HANDED_OFF,
  OUTCOME_EMPTY,
  OUTCOME_FAILED,
  OUTCOME_TIMED_OUT,
}
