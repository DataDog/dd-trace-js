'use strict'

const { channel } = require('dc-polyfill')
const {
  pickTextMap,
  readBaggage,
  readB3,
  readB3Flags,
  readB3Sampled,
  readB3SpanId,
  readB3TraceId,
  readDatadogOrigin,
  readDatadogParentId,
  readDatadogSamplingPriority,
  readDatadogTags,
  readDatadogTraceId,
  readLegacyBaggage,
  readSqsd,
  readTraceparent,
  readTracestate,
  writeBaggage,
  writeB3,
  writeB3Flags,
  writeB3ParentId,
  writeB3Sampled,
  writeB3SpanId,
  writeB3TraceId,
  writeDatadogOrigin,
  writeDatadogParentId,
  writeDatadogSamplingPriority,
  writeDatadogTags,
  writeDatadogTraceId,
  writeLegacyBaggage,
  writeTraceparent,
  writeTracestate,
} = require('../../carrier')
const id = require('../../id')
const DatadogSpanContext = require('../span_context')
const log = require('../../log')
const tags = require('../../../../../ext/tags')
const { getConfiguredEnvName } = require('../../config/helper')
const { setAllBaggageItems, getAllBaggageItems, removeAllBaggageItems } = require('../../baggage')
const { hasTraceSourcePropagationTag } = require('../../standalone/tracesource')
const telemetryMetrics = require('../../telemetry/metrics')
const { DD_MAJOR } = require('../../../../../version')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')
const TraceState = require('./tracestate')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

const b3TraceExpr = /^([0-9a-f]{16}){1,2}$/i
const b3SpanExpr = /^[0-9a-f]{16}$/i
const b3HeaderExpr = /^(([0-9a-f]{16}){1,2}-[0-9a-f]{16}(-[01d](-[0-9a-f]{16})?)?|[01d])$/i
// W3C Baggage key grammar: key = token (RFC 7230).
// Spec (up-to-date): "Propagation format for distributed context: Baggage" §3.3.1
// https://www.w3.org/TR/baggage/#header-content
// https://www.rfc-editor.org/rfc/rfc7230#section-3.2.6
const baggageTokenExpr = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const tagKeyExpr = /^_dd\.p\.[\x21-\x2B\x2D-\x7E]+$/ // ASCII minus spaces and commas
const tagValueExpr = /^[\x20-\x2B\x2D-\x7E]*$/ // ASCII minus commas
// Compatible with Node's internal header value validation (allows HTAB, SP-~, and \x80-\xFF only)
// https://github.com/nodejs/node/blob/main/lib/_http_common.js
const invalidHeaderValueCharExpr = /[^\t\x20-\x7E\x80-\xFF]/
const traceparentExpr = /^([a-f0-9]{2})-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})(-.*)?$/i
// Origin value in tracestate replaces '~', ',' and ';' with '_"
const tracestateOriginFilter = /[^\x20-\x2B\x2D-\x3A\x3C-\x7D]/g
// Tag keys in tracestate replace ' ', ',' and '=' with '_'
const tracestateTagKeyFilter = /[^\x21-\x2B\x2D-\x3C\x3E-\x7E]/g
// Tag values in tracestate replace ',', '~' and ';' with '_'
const tracestateTagValueFilter = /[^\x20-\x2B\x2D-\x3A\x3C-\x7D]/g
const invalidSegment = /^0+$/
const zeroTraceId = '0000000000000000'
const hex16 = /^[0-9A-Fa-f]{16}$/
const percentByte = /%([0-9A-Fa-f]{2})/g

let updateOtelTraceState

/**
 * @typedef {object} B3Context
 * @property {string} [flags]
 * @property {string} [sampled]
 * @property {string} [spanId]
 * @property {string} [traceId]
 */

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
 * @param {string | undefined} traceId
 * @param {string | undefined} spanId
 * @param {number} radix
 * @returns {DatadogSpanContext | undefined}
 */
function extractGenericContext (traceId, spanId, radix) {
  if (!traceId || invalidSegment.test(traceId)) return
  if (!spanId) return

  return new DatadogSpanContext({
    traceId: id(traceId, radix),
    spanId: id(spanId, radix),
    isRemote: true,
  })
}

/**
 * @param {string} traceId
 * @param {DatadogSpanContext} spanContext
 * @returns {void}
 */
function extract128BitTraceId (traceId, spanContext) {
  const buffer = spanContext._traceId.toBuffer()

  if (buffer.length !== 16) return

  const tid = traceId.slice(0, 16)

  if (tid === zeroTraceId) return

  spanContext._trace.tags['_dd.p.tid'] = tid
}

/**
 * @param {string | undefined} sampled
 * @param {boolean} debug
 * @returns {import('../../priority_sampler').SamplingPriority | undefined}
 */
function getB3Priority (sampled, debug) {
  if (debug) {
    return USER_KEEP
  } else if (sampled === '1') {
    return AUTO_KEEP
  } else if (sampled === '0') {
    return AUTO_REJECT
  }
}

/**
 * @param {B3Context} b3
 * @returns {DatadogSpanContext | undefined}
 */
function extractB3Context (b3) {
  const priority = getB3Priority(b3.sampled, b3.flags === '1')
  const spanContext = extractGenericContext(b3.traceId, b3.spanId, 16)

  if (priority !== undefined) {
    if (!spanContext) {
      return new DatadogSpanContext({
        traceId: id(),
        spanId: null,
        sampling: { priority },
        isRemote: true,
      })
    }

    spanContext._sampling.priority = priority
  }

  if (spanContext && b3.traceId) extract128BitTraceId(b3.traceId, spanContext)

  return spanContext
}

/**
 * @param {Record<string, unknown>} carrier
 * @returns {B3Context | undefined}
 */
function extractB3MultipleHeaders (carrier) {
  // Parent ID is intentionally not a standalone signal for B3 extraction.
  const traceId = readB3TraceId(carrier)
  const sampled = readB3Sampled(carrier)
  const flags = readB3Flags(carrier)

  if (traceId === undefined && sampled === undefined && flags === undefined) return

  let empty = true
  const b3 = {}
  const spanId = readB3SpanId(carrier)

  if (traceId && spanId && b3TraceExpr.test(traceId) && b3SpanExpr.test(spanId)) {
    b3.traceId = traceId
    b3.spanId = spanId
    empty = false
  }

  if (sampled) {
    b3.sampled = sampled
    empty = false
  }

  if (flags) {
    b3.flags = flags
    empty = false
  }

  return empty ? undefined : b3
}

/**
 * @param {string} header
 * @returns {B3Context}
 */
function extractB3SingleHeader (header) {
  const traceIdEnd = header.indexOf('-')

  if (traceIdEnd === -1) {
    if (header === 'd') {
      return {
        sampled: '1',
        flags: '1',
      }
    }
    return {
      sampled: header,
    }
  }

  const spanIdStart = traceIdEnd + 1
  const spanIdEnd = spanIdStart + 16
  const b3 = {
    traceId: header.slice(0, traceIdEnd),
    spanId: header.slice(spanIdStart, spanIdEnd),
  }

  if (header.length > spanIdEnd) {
    const sampled = header[spanIdEnd + 1]
    b3.sampled = sampled === '0' ? '0' : '1'

    if (sampled === 'd') {
      b3.flags = '1'
    }
  }

  return b3
}

/**
 * @param {Record<string, unknown>} carrier
 * @returns {DatadogSpanContext | undefined}
 */
function extractB3MultiContext (carrier) {
  const b3 = extractB3MultipleHeaders(carrier)
  if (b3 === undefined) return
  return extractB3Context(b3)
}

/**
 * @param {Record<string, unknown>} carrier
 * @returns {DatadogSpanContext | undefined}
 */
function extractB3SingleContext (carrier) {
  // Resolve the value before running the regex on the common header-less path.
  const header = readB3(carrier)
  if (!header || !b3HeaderExpr.test(header)) return
  return extractB3Context(extractB3SingleHeader(header))
}

class TextMapPropagator {
  /** @type {Set<string> | undefined} Cached `Set` view of `#config.baggageTagKeys`. */
  #baggageTagKeysSet

  /** @type {string[] | undefined} Source array that `#baggageTagKeysSet` was built from. */
  #baggageTagKeysSetSource

  /** @type {import('../../config')} */
  #config

  /** @type {typeof extractB3SingleContext | typeof extractB3MultiContext} */
  #extractB3Context

  /** @param {import('../../config')} config */
  constructor (config) {
    this.#config = config

    // v6+: `'b3'` is always single-header. v5: `OTEL_PROPAGATORS` callers
    // expect single, legacy `DD_TRACE_PROPAGATION_STYLE` callers expect multi.
    /* istanbul ignore else: v5 fallback */
    if (DD_MAJOR >= 6) {
      this.#extractB3Context = extractB3SingleContext
    } else {
      const envName = getConfiguredEnvName('DD_TRACE_PROPAGATION_STYLE')
      // eslint-disable-next-line eslint-rules/eslint-env-aliases
      this.#extractB3Context = envName === 'OTEL_PROPAGATORS'
        ? extractB3SingleContext
        : extractB3MultiContext
    }
  }

  /**
   * Returns a `Set` view of `#config.baggageTagKeys` that is rebuilt only
   * when the source array reference changes. Avoids an `O(n)` `Set` alloc
   * per baggage extract (which is per-request when baggage propagation is
   * enabled).
   *
   * @returns {Set<string>}
   */
  #getBaggageTagKeysSet () {
    const source = this.#config.baggageTagKeys
    if (this.#baggageTagKeysSetSource !== source) {
      this.#baggageTagKeysSet = new Set(source)
      this.#baggageTagKeysSetSource = source
    }
    return this.#baggageTagKeysSet
  }

  /**
   * @param {DatadogSpanContext | null | undefined} spanContext
   * @param {Record<string, string>} [carrier]
   * @returns {Record<string, string> | undefined}
   */
  inject (spanContext, carrier) {
    if (carrier === null) return
    let injectedCarrier = this.#injectBaggageItems(spanContext, carrier)
    if (!spanContext) return injectedCarrier

    const injectTraceContext = this.#config.apmTracingEnabled !== false ||
      hasTraceSourcePropagationTag(spanContext._trace.tags)
    let traceTagReplacements
    let optionalTraceTagCount = 0
    if (injectTraceContext && injectCh.hasSubscribers && (
      this.#hasPropagationStyle('inject', 'datadog') || this.#hasPropagationStyle('inject', 'tracecontext')
    )) {
      const injection = { spanContext }
      injectCh.publish(injection)
      traceTagReplacements = injection.traceTagReplacements
      optionalTraceTagCount = injection.optionalTraceTagCount ?? 0
    }
    if (injectTraceContext) {
      injectedCarrier = this.#injectDatadog(
        spanContext, injectedCarrier ?? carrier, traceTagReplacements, optionalTraceTagCount
      ) ?? injectedCarrier
      injectedCarrier = this.#injectB3MultipleHeaders(spanContext, injectedCarrier ?? carrier) ?? injectedCarrier
      injectedCarrier = this.#injectB3SingleHeader(spanContext, injectedCarrier ?? carrier) ?? injectedCarrier
    }
    injectedCarrier = this
      .#injectTraceparent(
        spanContext, injectedCarrier ?? carrier, injectTraceContext, traceTagReplacements
      ) ?? injectedCarrier

    if (injectedCarrier === undefined) return

    carrier = injectedCarrier

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Inject into carrier: ${JSON.stringify(pickTextMap(carrier))}.`)

    return carrier
  }

  /**
   * @param {Record<string, unknown>} carrier
   * @returns {DatadogSpanContext | null}
   */
  extract (carrier) {
    const spanContext = this.#extractSpanContext(carrier)
    if (spanContext === undefined) return null

    if (extractCh.hasSubscribers) {
      extractCh.publish({ spanContext, carrier })
    }

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => {
      const keys = JSON.stringify(pickTextMap(carrier))
      const styles = this.#config.tracePropagationStyle.extract.join(', ')

      return `Extract from carrier (${styles}): ${keys}.`
    })

    return spanContext
  }

  /**
   * @param {DatadogSpanContext} spanContext
   * @param {Record<string, string>} [carrier]
   * @param {Array<string | undefined>} [traceTagReplacements]
   * @param {number} optionalTraceTagCount
   * @returns {Record<string, string> | undefined}
   */
  #injectDatadog (spanContext, carrier, traceTagReplacements, optionalTraceTagCount) {
    if (!this.#hasPropagationStyle('inject', 'datadog')) return

    carrier ??= {}
    writeDatadogTraceId(carrier, spanContext.toTraceId())
    writeDatadogParentId(carrier, spanContext.toSpanId())

    const origin = spanContext._trace.origin
    if (origin) writeDatadogOrigin(carrier, origin)

    const priority = spanContext._sampling.priority
    if (Number.isInteger(priority)) writeDatadogSamplingPriority(carrier, priority.toString())

    this.#injectTags(carrier, spanContext._trace.tags, traceTagReplacements, optionalTraceTagCount)

    return carrier
  }

  /**
   * @param {DatadogSpanContext | null | undefined} spanContext
   * @param {Record<string, string>} [carrier]
   * @returns {Record<string, string> | undefined}
   */
  #injectBaggageItems (spanContext, carrier) {
    let injectedCarrier
    if (this.#config.legacyBaggageEnabled) {
      const baggageItems = spanContext?._baggageItems
      if (baggageItems) {
        for (const key of Object.keys(baggageItems)) {
          let headerValue = String(baggageItems[key])
          // Avoid Node throwing ERR_INVALID_CHAR when setting header values (e.g. newline from decoded OTEL baggage).
          if (invalidHeaderValueCharExpr.test(headerValue)) {
            headerValue = encodeURIComponent(headerValue)
          }
          const nextCarrier = writeLegacyBaggage(injectedCarrier ?? carrier, key, headerValue)
          if (nextCarrier === undefined) {
            tracerMetrics.count('context_header_style.malformed', ['header_style:baggage']).inc()
            continue
          }
          injectedCarrier = nextCarrier
        }
      }
    }

    if (this.#hasPropagationStyle('inject', 'baggage')) {
      let baggage = ''
      let itemCounter = 0
      let byteCounter = 0

      const baggageItems = getAllBaggageItems()
      for (const key of Object.keys(baggageItems)) {
        const baggageKey = key.trim()
        if (!baggageTokenExpr.test(baggageKey)) continue

        // Do not trim values. If callers include leading/trailing whitespace, it must be percent-encoded.
        // W3C list-member allows optional properties after ';'.
        // https://www.w3.org/TR/baggage/#header-content
        const item = `${baggageKey}=${encodeURIComponent(baggageItems[key])},`
        itemCounter += 1
        byteCounter += item.length

        // Check for item count limit exceeded
        if (itemCounter > this.#config.baggageMaxItems) {
          tracerMetrics.count('context_header.truncated', ['truncation_reason:baggage_item_count_exceeded']).inc()
          break
        }

        // Check for byte count limit exceeded
        if (byteCounter > this.#config.baggageMaxBytes) {
          tracerMetrics.count('context_header.truncated', ['truncation_reason:baggage_byte_count_exceeded']).inc()
          break
        }

        baggage += item
      }

      baggage = baggage.slice(0, -1)
      if (baggage) {
        injectedCarrier ??= carrier ?? {}
        writeBaggage(injectedCarrier, baggage)
        tracerMetrics.count('context_header_style.injected', ['header_style:baggage']).inc()
      }
    }

    return injectedCarrier
  }

  /**
   * @param {Record<string, string>} carrier
   * @param {Record<string, string>} traceTags
   * @param {Array<string | undefined>} [traceTagReplacements]
   * @param {number} optionalTraceTagCount
   * @returns {void}
   */
  #injectTags (carrier, traceTags, traceTagReplacements, optionalTraceTagCount) {
    if (this.#config.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH === 0) {
      log.debug('Trace tag propagation is disabled, skipping injection.')
      return
    }

    const maxLength = this.#config.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH
    let header = ''

    for (const key of Object.keys(traceTags)) {
      const value = traceTags[key]
      if (!value || !key.startsWith('_dd.p.') ||
        traceTagReplacements && hasTraceTagReplacement(traceTagReplacements, key)) {
        continue
      }
      if (!tagKeyExpr.test(key) || !tagValueExpr.test(value)) {
        log.error('Trace tags from span are invalid, skipping injection.')
        return
      }

      if (header) header += ','
      header += `${key}=${value}`
    }

    if (traceTagReplacements) {
      const requiredEntryCount = traceTagReplacements.length - optionalTraceTagCount * 2
      for (let index = 0; index < traceTagReplacements.length; index += 2) {
        const key = traceTagReplacements[index]
        const value = traceTagReplacements[index + 1]
        if (!value || !key.startsWith('_dd.p.')) continue
        if (!tagKeyExpr.test(key) || !tagValueExpr.test(value)) {
          log.error('Trace tags from span are invalid, skipping injection.')
          return
        }

        const entry = `${header ? ',' : ''}${key}=${value}`
        if (index >= requiredEntryCount && header.length + entry.length > maxLength) break
        header += entry
      }
    }

    if (header.length > maxLength) {
      log.error('Trace tags from span are too large, skipping injection.')
    } else if (header) {
      writeDatadogTags(carrier, header)
    }
  }

  /**
   * @param {DatadogSpanContext} spanContext
   * @param {Record<string, string>} [carrier]
   * @returns {Record<string, string> | undefined}
   */
  #injectB3MultipleHeaders (spanContext, carrier) {
    // v5 also accepts the legacy `'b3'` spelling for multi; v6+ routes `'b3'` to single-header.
    const hasB3multi = this.#hasPropagationStyle('inject', 'b3multi') ||
      (DD_MAJOR < 6 && this.#hasPropagationStyle('inject', 'b3'))
    if (!hasB3multi) return

    carrier ??= {}
    writeB3TraceId(carrier, spanContext._traceId.toTraceIdHex(spanContext._trace.tags['_dd.p.tid']))
    writeB3SpanId(carrier, spanContext._spanId.toString(16))
    writeB3Sampled(carrier, spanContext._sampling.priority >= AUTO_KEEP ? '1' : '0')

    if (spanContext._sampling.priority > AUTO_KEEP) {
      writeB3Flags(carrier, '1')
    }

    if (spanContext._parentId) {
      writeB3ParentId(carrier, spanContext._parentId.toString(16))
    }

    return carrier
  }

  /**
   * @param {DatadogSpanContext} spanContext
   * @param {Record<string, string>} [carrier]
   * @returns {Record<string, string> | undefined}
   */
  #injectB3SingleHeader (spanContext, carrier) {
    // v6+ keeps `'b3 single header'` as a back-compat alias for callers that bypass parser normalisation.
    const hasB3SingleHeader = this.#hasPropagationStyle('inject', 'b3 single header') ||
      (DD_MAJOR >= 6 && this.#hasPropagationStyle('inject', 'b3'))
    if (!hasB3SingleHeader) return

    carrier ??= {}
    const traceId = spanContext._traceId.toTraceIdHex(spanContext._trace.tags['_dd.p.tid'])
    const spanId = spanContext._spanId.toString(16)
    const sampled = spanContext._sampling.priority >= AUTO_KEEP ? '1' : '0'

    let header = `${traceId}-${spanId}-${sampled}`
    if (spanContext._parentId) {
      header += '-' + spanContext._parentId.toString(16)
    }
    writeB3(carrier, header)

    return carrier
  }

  /**
   * @param {DatadogSpanContext} spanContext
   * @param {Record<string, string> | undefined} carrier
   * @param {boolean} injectTraceContext
   * @param {Array<string | undefined>} [traceTagReplacements]
   * @returns {Record<string, string> | undefined}
   */
  #injectTraceparent (spanContext, carrier, injectTraceContext, traceTagReplacements) {
    if (!this.#hasPropagationStyle('inject', 'tracecontext')) return

    if (!injectTraceContext) {
      const tracestate = TraceState.fromString(spanContext._tracestate?.toString())
      tracestate.delete('dd')
      const header = tracestate.toString()
      if (!header) return
      carrier ??= {}
      writeTracestate(carrier, header)
      return carrier
    }

    carrier ??= {}
    const {
      _sampling: { priority, mechanism },
      _tracestate,
      _trace: { origin },
    } = spanContext
    const ts = traceTagReplacements
      ? TraceState.fromString(_tracestate?.toString())
      : _tracestate ?? new TraceState()

    writeTraceparent(carrier, spanContext.toTraceparent())

    updateOtelTraceState ??= require('../../otel-sampling').updateOtelTraceState
    updateOtelTraceState(spanContext, ts)

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

    writeTracestate(carrier, ts.toString())

    return carrier
  }

  /**
   * @param {'inject' | 'extract'} mode
   * @param {string} name
   * @returns {boolean}
   */
  #hasPropagationStyle (mode, name) {
    return this.#config.tracePropagationStyle[mode].includes(name)
  }

  /**
   * @param {DatadogSpanContext | undefined} w3cSpanContext
   * @param {DatadogSpanContext} firstSpanContext
   * @param {Record<string, unknown>} carrier
   * @param {DatadogSpanContext | undefined} datadogContext
   * @returns {DatadogSpanContext}
   */
  #resolveTraceContextConflicts (w3cSpanContext, firstSpanContext, carrier, datadogContext) {
    if (w3cSpanContext === undefined ||
        firstSpanContext.toTraceId(true) !== w3cSpanContext.toTraceId(true)) {
      return firstSpanContext
    }

    const selectedPriority = firstSpanContext._sampling.priority
    if (selectedPriority !== undefined &&
        (selectedPriority >= AUTO_KEEP) !== (w3cSpanContext._sampling.priority >= AUTO_KEEP)) {
      // The W3C threshold describes its sampled bit, not the conflicting decision selected from another style.
      firstSpanContext._sampling.isProbabilityDecision = false
    }

    firstSpanContext._tracestate = w3cSpanContext._tracestate
    if (firstSpanContext.toSpanId() === w3cSpanContext.toSpanId()) return firstSpanContext

    if (tags.DD_PARENT_ID in w3cSpanContext._trace.tags) {
      // tracecontext headers contain a p value, ensure this value is sent to backend
      firstSpanContext._trace.tags[tags.DD_PARENT_ID] = w3cSpanContext._trace.tags[tags.DD_PARENT_ID]
    } else {
      // if p value is not present in tracestate, use the parent id from the datadog headers
      datadogContext ||= extractGenericContext(readDatadogTraceId(carrier), readDatadogParentId(carrier), 10)
      if (datadogContext) {
        firstSpanContext._trace.tags[tags.DD_PARENT_ID] = datadogContext._spanId.toString().padStart(16, '0')
      }
    }
    // the span_id in tracecontext takes precedence over the first extracted propagation style
    firstSpanContext._spanId = w3cSpanContext._spanId
    return firstSpanContext
  }

  /**
   * @param {Record<string, unknown>} carrier
   * @returns {DatadogSpanContext | undefined}
   */
  #extractSpanContext (carrier) {
    let context
    let datadogContext
    let style = ''
    let extractBaggage = false
    let traceContext
    let traceContextExtracted = false
    for (const extractor of this.#config.tracePropagationStyle.extract) {
      let extractedContext
      switch (extractor) {
        case 'datadog':
          datadogContext = this.#extractDatadogContext(carrier)
          extractedContext = datadogContext
          if (extractedContext !== undefined && !this.#config.DD_TRACE_PROPAGATION_EXTRACT_FIRST) {
            if (!traceContextExtracted) {
              traceContext = this.#extractTraceparentContext(carrier)
              traceContextExtracted = true
            }
            this.#addTraceContextState(extractedContext, traceContext)
          }
          break
        case 'tracecontext':
          if (!traceContextExtracted) {
            traceContext = this.#extractTraceparentContext(carrier)
            traceContextExtracted = true
          }
          extractedContext = traceContext
          break
        case 'b3':
          extractedContext = this.#extractB3Context(carrier)
          break
        case 'b3 single header':
          extractedContext = extractB3SingleContext(carrier)
          break
        case 'b3multi':
          extractedContext = extractB3MultiContext(carrier)
          break
        case 'baggage':
          extractBaggage = true
          continue
        case 'none':
          continue
        default:
          log.warn('Unknown propagation style:', extractor)
          continue
      }
      if (extractedContext === undefined) {
        continue
      }

      if (context === undefined) {
        context = extractedContext
        style = extractor
        if (this.#config.DD_TRACE_PROPAGATION_EXTRACT_FIRST) {
          break
        }
      } else {
        // If extractor is tracecontext, add tracecontext specific information to the context
        if (extractor === 'tracecontext') {
          context = this.#resolveTraceContextConflicts(
            extractedContext, context, carrier, datadogContext)
        }
        if (extractedContext._traceId && extractedContext._spanId &&
          extractedContext.toTraceId(true) !== context.toTraceId(true)) {
          const link = {
            context: extractedContext,
            attributes: { reason: 'terminated_context', context_headers: extractor },
          }
          context._links.push(link)
        }
      }
    }

    if (context && (style === 'datadog' || style === 'tracecontext')) {
      this.#extractLegacyBaggageItems(carrier, context)
    }

    if (this.#config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT === 'ignore') {
      if (context !== undefined) context._links = []
    } else {
      if (this.#config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT === 'restart' && context) {
        context._links = []
        context._links.push({
          context,
          attributes:
          {
            reason: 'propagation_behavior_extract', context_headers: style,
          },
        })
      }
      if (!extractBaggage && this.#config.DD_TRACE_PROPAGATION_EXTRACT_FIRST) {
        extractBaggage = this.#hasPropagationStyle('extract', 'baggage')
      }
      this.#extractBaggageItems(carrier, context, extractBaggage)
    }

    return context || this.#extractSqsdContext(carrier)
  }

  /**
   * @param {Record<string, unknown>} carrier
   * @returns {DatadogSpanContext | undefined}
   */
  #extractDatadogContext (carrier) {
    if (!carrier) return
    const traceId = readDatadogTraceId(carrier)
    if (!traceId) return
    const spanContext = extractGenericContext(traceId, readDatadogParentId(carrier), 10)

    if (!spanContext) return spanContext

    const origin = readDatadogOrigin(carrier)
    if (typeof origin === 'string') spanContext._trace.origin = origin

    const header = readDatadogSamplingPriority(carrier)
    if (header !== undefined) {
      const priority = Number.parseInt(header, 10)
      if (Number.isInteger(priority)) spanContext._sampling.priority = priority
    }

    const traceTags = this.#extractTags(carrier)
    if (traceTags) spanContext._trace.tags = traceTags

    return spanContext
  }

  /**
   * @param {Record<string, unknown>} carrier
   * @returns {DatadogSpanContext | undefined}
   */
  #extractSqsdContext (carrier) {
    const headerValue = readSqsd(carrier)
    if (!headerValue) return
    let parsed
    try {
      parsed = JSON.parse(headerValue)
    } catch {
      return
    }
    const spanContext = this.#extractDatadogContext(parsed)
    if (!spanContext) return

    this.#extractLegacyBaggageItems(parsed, spanContext)
    if (this.#config.DD_TRACE_PROPAGATION_EXTRACT_FIRST) return spanContext

    this.#addTraceContextState(spanContext, this.#extractTraceparentContext(parsed))
    return spanContext
  }

  /**
   * @param {DatadogSpanContext} datadogContext
   * @param {DatadogSpanContext | undefined} traceContext
   */
  #addTraceContextState (datadogContext, traceContext) {
    if (traceContext && datadogContext._traceId.equals(traceContext._traceId)) {
      datadogContext._traceparent = traceContext._traceparent
      datadogContext._tracestate = traceContext._tracestate
    }
  }

  /**
   * @param {Record<string, unknown>} carrier
   * @returns {DatadogSpanContext | undefined}
   */
  #extractTraceparentContext (carrier) {
    const headerValue = readTraceparent(carrier)
    if (!headerValue) return
    const matches = headerValue.trim().match(traceparentExpr)
    if (matches !== null) {
      const [, version, traceId, spanId, flags, tail] = matches
      const traceparent = { version }
      // W3C Trace Context §3.3.1.1: multiple tracestate fields MUST be combined per RFC 7230 §3.2.2.
      const tracestate = TraceState.fromString(readTracestate(carrier))
      if (invalidSegment.test(traceId)) return
      if (invalidSegment.test(spanId)) return

      // Version ff is considered invalid
      if (version === 'ff') return

      // Version 00 should have no tail, but future versions may
      if (tail && version === '00') return

      const spanContext = new DatadogSpanContext({
        traceId: id(traceId, 16),
        spanId: id(spanId, 16),
        isRemote: true,
        sampling: { priority: Number.parseInt(flags, 16) & 1 ? 1 : 0 },
        traceparent,
        tracestate,
      })

      extract128BitTraceId(traceId, spanContext)

      tracestate.forVendor('dd', state => {
        for (const [key, value] of state.entries()) {
          switch (key) {
            case 'p': {
              spanContext._trace.tags[tags.DD_PARENT_ID] = value
              break
            }
            case 's': {
              const priority = Number.parseInt(value, 10)
              if (!Number.isInteger(priority)) continue
              if (
                (spanContext._sampling.priority === 1 && priority > 0) ||
                (spanContext._sampling.priority === 0 && priority < 0)
              ) {
                spanContext._sampling.priority = priority
              }
              break
            }
            case 'o':
              spanContext._trace.origin = value.replaceAll('~', '=')
              break
            case 't.dm': {
              const mechanism = Math.abs(Number.parseInt(value, 10))
              if (Number.isInteger(mechanism)) {
                spanContext._sampling.mechanism = mechanism
                spanContext._trace.tags['_dd.p.dm'] = `-${mechanism}`
              }
              break
            }
            default: {
              if (!key.startsWith('t.')) continue
              const subKey = key.slice(2) // e.g. t.tid -> tid
              const transformedValue = value.replaceAll('~', '=')

              // If subkey is tid  then do nothing because trace header tid should always be preserved
              if (subKey === 'tid') {
                if (!hex16.test(value) || spanContext._trace.tags['_dd.p.tid'] !== transformedValue) {
                  log.error('Invalid trace id %s in tracestate, skipping', value)
                }
                continue
              }
              spanContext._trace.tags[`_dd.p.${subKey}`] = transformedValue
            }
          }
        }
      })

      return spanContext
    }
  }

  /**
   * @param {Record<string, unknown>} carrier
   * @param {DatadogSpanContext} spanContext
   * @returns {void}
   */
  #extractLegacyBaggageItems (carrier, spanContext) {
    if (!this.#config.legacyBaggageEnabled) return
    readLegacyBaggage(carrier, spanContext._baggageItems)
  }

  /**
   * @param {Record<string, unknown> | undefined} carrier
   * @param {DatadogSpanContext | undefined} spanContext
   * @param {boolean} extractBaggage
   * @returns {void}
   */
  #extractBaggageItems (carrier, spanContext, extractBaggage) {
    removeAllBaggageItems()
    if (!carrier || !extractBaggage) return
    const header = readBaggage(carrier)
    if (!header) return

    const baggageTagKeys = this.#getBaggageTagKeysSet()
    const tagAllKeys = baggageTagKeys.has('*')
    /** @type {Record<string, string> | undefined} */
    let items
    let itemCount = 0
    let byteCount = 0
    let start = 0

    while (start <= header.length) {
      if (itemCount >= this.#config.baggageMaxItems) {
        tracerMetrics.count('context_header.truncated', ['truncation_reason:baggage_item_count_exceeded']).inc()
        break
      }

      const memberStart = start
      const commaIndex = header.indexOf(',', memberStart)
      const end = commaIndex === -1 ? header.length : commaIndex

      // Charge the comma slot before the empty-entry skip so a `,,,,,foo=bar` can't iterate for free.
      byteCount += end - memberStart + 1
      if (byteCount > this.#config.baggageMaxBytes) {
        tracerMetrics.count('context_header.truncated', ['truncation_reason:baggage_byte_count_exceeded']).inc()
        break
      }
      if (memberStart === end) {
        start = end + 1
        continue
      }

      // Per W3C baggage, list-members can contain optional properties after `;`.
      // Example: key=value;prop=1;prop2
      // https://www.w3.org/TR/baggage/#header-content
      let memberEnd = header.indexOf(';', memberStart)
      if (memberEnd === -1 || memberEnd > end) memberEnd = end
      const equalsIndex = header.indexOf('=', memberStart)
      start = end + 1

      if (equalsIndex === -1 || equalsIndex >= memberEnd) {
        const member = header.slice(memberStart, memberEnd).trim()
        if (!member) continue
        tracerMetrics.count('context_header_style.malformed', ['header_style:baggage']).inc()
        return
      }

      const key = header.slice(memberStart, equalsIndex).trim()
      let value = header.slice(equalsIndex + 1, memberEnd).trim()

      if (!baggageTokenExpr.test(key) || !value) {
        tracerMetrics.count('context_header_style.malformed', ['header_style:baggage']).inc()
        return
      }
      // `decodeURIComponent` only does work when the value contains a
      // percent-encoded sequence; everything else passes through unchanged.
      // Skipping the call (and the surrounding `try` frame) shaves an alloc
      // per baggage entry on the dominant ASCII case.
      if (value.includes('%')) {
        try {
          value = decodeURIComponent(value)
        } catch {
          const bytes = value.replaceAll(percentByte, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
          value = Buffer.from(bytes, 'binary').toString('utf8')
        }
      }
      items ??= {}
      items[key] = value
      itemCount++

      if (spanContext && (tagAllKeys || baggageTagKeys.has(key))) {
        spanContext._trace.tags['baggage.' + key] = value
      }
    }

    if (items) {
      setAllBaggageItems(items)
      tracerMetrics.count('context_header_style.extracted', ['header_style:baggage']).inc()
    }
  }

  /**
   * @param {Record<string, unknown>} carrier
   * @returns {Record<string, string> | undefined}
   */
  #extractTags (carrier) {
    const header = readDatadogTags(carrier)
    if (!header) return

    if (this.#config.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH === 0) {
      log.debug('Trace tag propagation is disabled, skipping extraction.')
    } else if (header.length > this.#config.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH) {
      log.error('Trace tags from carrier are too large, skipping extraction.')
    } else {
      const tags = {}
      let start = 0
      let separator = header.indexOf('=')

      while (start <= header.length) {
        const comma = header.indexOf(',', start)
        const end = comma === -1 ? header.length : comma
        const hasSeparator = separator !== -1 && separator < end
        const key = header.slice(start, hasSeparator ? separator : end)
        const value = hasSeparator ? header.slice(separator + 1, end) : ''

        if (!tagKeyExpr.test(key) || !tagValueExpr.test(value)) {
          log.error('Trace tags from carrier are invalid, skipping extraction.')
          return
        }
        if (key === '_dd.p.tid' && !hex16.test(value)) {
          log.error('Invalid _dd.p.tid tag %s, skipping', value)
        } else {
          tags[key] = value
        }

        start = end + 1
        if (hasSeparator) separator = header.indexOf('=', start)
      }

      return tags
    }
  }
}

module.exports = TextMapPropagator
