'use strict'

const tags = require('../../../../../ext/tags')
const TraceState = require('./tracestate')

// Origin value in tracestate replaces '~', ',' and ';' with '_'.
const tracestateOriginFilter = /[^\x20-\x2B\x2D-\x3A\x3C-\x7D]/g
// Tag keys in tracestate replace ' ', ',' and '=' with '_'.
const tracestateTagKeyFilter = /[^\x21-\x2B\x2D-\x3C\x3E-\x7E]/g
// Tag values in tracestate replace ',', '~' and ';' with '_'.
const tracestateTagValueFilter = /[^\x20-\x2B\x2D-\x3A\x3C-\x7D]/g

let updateOtelTraceState

/**
 * @param {Array<string | undefined>} traceTagReplacements
 * @param {string} key
 * @returns {boolean}
 */
function hasTraceTagReplacement (traceTagReplacements, key) {
  for (let index = 0; index < traceTagReplacements.length; index += 2) {
    if (traceTagReplacements[index] === key) return true
  }
  return false
}

/**
 * Builds the W3C tracestate for propagation or OTLP export from the live span context.
 *
 * @param {import('../span_context')} spanContext
 * @param {Array<string | undefined>} [traceTagReplacements]
 * @returns {string}
 */
function formatTraceState (spanContext, traceTagReplacements) {
  const {
    _sampling: { priority, mechanism },
    _tracestate,
    _trace: { origin },
  } = spanContext
  const traceState = traceTagReplacements
    ? TraceState.fromString(_tracestate?.toString())
    : _tracestate ?? new TraceState()

  updateOtelTraceState ??= require('../../otel-sampling').updateOtelTraceState
  updateOtelTraceState(spanContext, traceState)

  traceState.forVendor('dd', state => {
    if (!spanContext._isRemote) {
      state.set('p', spanContext._spanId)
    } else if (spanContext._trace.tags[tags.DD_PARENT_ID]) {
      state.set('p', spanContext._trace.tags[tags.DD_PARENT_ID])
    }
    state.set('s', priority)
    if (mechanism) {
      state.set('t.dm', `-${mechanism}`)
    }

    if (typeof origin === 'string') {
      const originValue = origin
        .replaceAll(tracestateOriginFilter, '_')
        .replaceAll('=', '~')

      state.set('o', originValue)
    }

    for (const key of Object.keys(spanContext._trace.tags)) {
      if (traceTagReplacements && hasTraceTagReplacement(traceTagReplacements, key)) continue
      const tagValueRaw = spanContext._trace.tags[key]
      if (!tagValueRaw || !key.startsWith('_dd.p.')) continue

      const tagKey = 't.' + key.slice(6)
        .replaceAll(tracestateTagKeyFilter, '_')

      const tagValue = tagValueRaw
        .toString()
        .replaceAll(tracestateTagValueFilter, '_')
        .replaceAll('=', '~')

      state.set(tagKey, tagValue)
    }

    if (traceTagReplacements) {
      for (let index = 0; index < traceTagReplacements.length; index += 2) {
        const key = traceTagReplacements[index]
        if (!key.startsWith('_dd.p.')) continue

        const tagKey = 't.' + key.slice(6)
          .replaceAll(tracestateTagKeyFilter, '_')
        const tagValueRaw = traceTagReplacements[index + 1]
        if (!tagValueRaw) {
          state.delete(tagKey)
          continue
        }

        const tagValue = tagValueRaw
          .toString()
          .replaceAll(tracestateTagValueFilter, '_')
          .replaceAll('=', '~')

        state.set(tagKey, tagValue)
      }
    }
  })

  return traceState.toString()
}

module.exports = {
  formatTraceState,
  hasTraceTagReplacement,
}
