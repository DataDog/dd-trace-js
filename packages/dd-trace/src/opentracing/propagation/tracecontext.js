'use strict'

const tags = require('../../../../../ext/tags')
const TraceState = require('./tracestate')

// Origin value in tracestate replaces '~', ',' and ';' with '_"
const tracestateOriginFilter = /[^\x20-\x2B\x2D-\x3A\x3C-\x7D]/g
// Tag keys in tracestate replace ' ', ',' and '=' with '_'
const tracestateTagKeyFilter = /[^\x21-\x2B\x2D-\x3C\x3E-\x7E]/g
// Tag values in tracestate replace ',', '~' and ';' with '_'
const tracestateTagValueFilter = /[^\x20-\x2B\x2D-\x3A\x3C-\x7D]/g

let otelSampling

/**
 * @typedef {object} TraceTagInjection
 * @property {import('../span_context')} spanContext
 * @property {Array<string | undefined>} [traceTagReplacements]
 * @property {number} [optionalTraceTagCount]
 */

/**
 * @param {Array<string | undefined>} traceTagReplacements
 * @param {string} key
 */
function hasTraceTagReplacement (traceTagReplacements, key) {
  for (let index = 0; index < traceTagReplacements.length; index += 2) {
    if (traceTagReplacements[index] === key) return true
  }
  return false
}

/** @param {string} key */
function toTraceStateTagKey (key) {
  return 't.' + key.slice(6).replaceAll(tracestateTagKeyFilter, '_')
}

/**
 * @param {string} key
 * @param {TraceTagInjection | undefined} injection
 */
function isOptionalDatadogTraceStateField (key, injection) {
  if (!key.startsWith('t.') || key === 't.dm' || key === 't.ts') return false

  const traceTagReplacements = injection?.traceTagReplacements
  if (!traceTagReplacements) return true
  const firstOptionalTraceTagIndex = traceTagReplacements.length - (injection.optionalTraceTagCount ?? 0) * 2
  for (let index = 0; index < firstOptionalTraceTagIndex; index += 2) {
    const traceTagKey = traceTagReplacements[index]
    if (traceTagKey.startsWith('_dd.p.') && toTraceStateTagKey(traceTagKey) === key) return false
  }
  return true
}

/**
 * Builds the W3C tracestate for propagation or OTLP export from the live span context.
 *
 * @param {import('../span_context')} spanContext
 * @param {Array<string | undefined>} [traceTagReplacements]
 * @param {TraceTagInjection} [traceTagInjection]
 */
function formatTraceState (spanContext, traceTagReplacements, traceTagInjection) {
  const {
    _sampling: { priority, mechanism },
    _tracestate,
    _trace: { origin },
  } = spanContext
  const ts = traceTagReplacements
    ? _tracestate?.clone() ?? new TraceState()
    : _tracestate ?? new TraceState()

  otelSampling ??= require('../../otel-sampling')
  otelSampling.updateOtelTraceState(spanContext, ts)

  ts.forVendor('dd', state => {
    if (!spanContext._isRemote) {
      // SpanContext was created by a ddtrace span.
      // Last datadog span id should be set to the current span.
      state.set('p', spanContext._spanId)
    } else if (spanContext._trace.tags[tags.DD_PARENT_ID]) {
      // Propagate the last Datadog span id set on the remote span.
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

      const tagKey = toTraceStateTagKey(key)

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

        const tagKey = toTraceStateTagKey(key)
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
  }, isOptionalDatadogTraceStateField, traceTagInjection)

  return ts.toString()
}

module.exports = {
  formatTraceState,
  hasTraceTagReplacement,
}
