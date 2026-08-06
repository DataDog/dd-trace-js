'use strict'

const log = require('./log')

/**
 * Validate optional span state tracking and retain only active spans.
 *
 * @param {object} trace Trace state to clear
 * @param {object[]} active Spans that remain active
 * @param {boolean} trackState Whether to validate trace ownership and duplicate spans
 * @param {WeakSet<object>} startedSpans Spans previously observed as started
 * @param {WeakSet<object>} finishedSpans Spans previously observed as finished
 */
function eraseTrace (trace, active, trackState, startedSpans, finishedSpans) {
  if (trackState) {
    const started = new Set()
    const startedIds = new Set()
    const finished = new Set()
    const finishedIds = new Set()

    for (const span of trace.finished) {
      const context = span.context()
      const id = context.toSpanId()

      if (finished.has(span)) {
        log.error('Span was already finished in the same trace: %s', span)
      } else {
        finished.add(span)

        if (finishedIds.has(id)) {
          log.error('Another span with the same ID was already finished in the same trace: %s', span)
        } else {
          finishedIds.add(id)
        }

        if (context._trace !== trace) {
          log.error('A span was finished in the wrong trace: %s', span)
        }

        if (finishedSpans.has(span)) {
          log.error('Span was already finished in a different trace: %s', span)
        } else {
          finishedSpans.add(span)
        }
      }
    }

    for (const span of trace.started) {
      const context = span.context()
      const id = context.toSpanId()

      if (started.has(span)) {
        log.error('Span was already started in the same trace: %s', span)
      } else {
        started.add(span)

        if (startedIds.has(id)) {
          log.error('Another span with the same ID was already started in the same trace: %s', span)
        } else {
          startedIds.add(id)
        }

        if (context._trace !== trace) {
          log.error('A span was started in the wrong trace: %s', span)
        }

        if (startedSpans.has(span)) {
          log.error('Span was already started in a different trace: %s', span)
        } else {
          startedSpans.add(span)
        }
      }

      if (!finished.has(span)) {
        log.error('Span started in one trace but was finished in another trace: %s', span)
      }
    }

    for (const span of trace.finished) {
      if (!started.has(span)) {
        log.error('Span finished in one trace but was started in another trace: %s', span)
      }
    }
  }

  trace.started = active
  trace.finished = []
}

module.exports = eraseTrace
