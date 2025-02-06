'use strict'

const pick = require('../../../../datadog-core/src/utils/src/pick')
const id = require('../../id')
const DatadogSpanContext = require('../span_context')
const OtelSpanContext = require('../../opentelemetry/span_context')
const log = require('../../log')
const TraceState = require('./tracestate')
const tags = require('../../../../../ext/tags')
const { channel } = require('dc-polyfill')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')

const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const originKey = 'x-datadog-origin'
const samplingKey = 'x-datadog-sampling-priority'
const tagsKey = 'x-datadog-tags'
const baggagePrefix = 'ot-baggage-'
const b3TraceKey = 'x-b3-traceid'
const b3TraceExpr = /^([0-9a-f]{16}){1,2}$/i
const b3SpanKey = 'x-b3-spanid'
const b3SpanExpr = /^[0-9a-f]{16}$/i
const b3ParentKey = 'x-b3-parentspanid'
const b3SampledKey = 'x-b3-sampled'
const b3FlagsKey = 'x-b3-flags'
const b3HeaderKey = 'b3'
const sqsdHeaderHey = 'x-aws-sqsd-attr-_datadog'
const b3HeaderExpr = /^(([0-9a-f]{16}){1,2}-[0-9a-f]{16}(-[01d](-[0-9a-f]{16})?)?|[01d])$/i
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)
const tagKeyExpr = /^_dd\.p\.[\x21-\x2b\x2d-\x7e]+$/ // ASCII minus spaces and commas
const tagValueExpr = /^[\x20-\x2b\x2d-\x7e]*$/ // ASCII minus commas
const ddKeys = [traceKey, spanKey, samplingKey, originKey]
const b3Keys = [b3TraceKey, b3SpanKey, b3ParentKey, b3SampledKey, b3FlagsKey, b3HeaderKey]
const logKeys = ddKeys.concat(b3Keys)
const traceparentExpr = /^([a-f0-9]{2})-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})(-.*)?$/i
const traceparentKey = 'traceparent'
// Origin value in tracestate replaces '~', ',' and ';' with '_"
const tracestateOriginFilter = /[^\x20-\x2b\x2d-\x3a\x3c-\x7d]/g
// Tag keys in tracestate replace ' ', ',' and '=' with '_'
const tracestateTagKeyFilter = /[^\x21-\x2b\x2d-\x3c\x3e-\x7e]/g
// Tag values in tracestate replace ',', '~' and ';' with '_'
const tracestateTagValueFilter = /[^\x20-\x2b\x2d-\x3a\x3c-\x7d]/g
const invalidSegment = /^0+$/
const zeroTraceId = '0000000000000000'

class TextMapPropagator {
  constructor (config) {
    this._config = config
  }

  inject (spanContext, carrier) {
    if (!spanContext || !carrier) return

    this._injectBaggageItems(spanContext, carrier)
    this._injectDatadog(spanContext, carrier)
    this._injectB3MultipleHeaders(spanContext, carrier)
    this._injectB3SingleHeader(spanContext, carrier)
    this._injectTraceparent(spanContext, carrier)

    if (injectCh.hasSubscribers) {
      injectCh.publish({ spanContext, carrier })
    }

    log.debug(() => `Inject into carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)
  }

  extract (carrier) {
    const spanContext = this._extractSpanContext(carrier)

    if (!spanContext) return spanContext

    if (extractCh.hasSubscribers) {
      extractCh.publish({ spanContext, carrier })
    }

    log.debug(() => `Extract from carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)

    return spanContext
  }

  _injectDatadog (spanContext, carrier) {
    if (!this._hasPropagationStyle('inject', 'datadog')) return

    carrier[traceKey] = spanContext.toTraceId()
    carrier[spanKey] = spanContext.toSpanId()

    this._injectOrigin(spanContext, carrier)
    this._injectSamplingPriority(spanContext, carrier)
    this._injectTags(spanContext, carrier)
  }

  _injectOrigin (spanContext, carrier) {
    const origin = spanContext._trace.origin

    if (origin) {
      carrier[originKey] = origin
    }
  }

  _injectSamplingPriority (spanContext, carrier) {
    const priority = spanContext._sampling.priority

    if (Number.isInteger(priority)) {
      carrier[samplingKey] = priority.toString()
    }
  }

  _encodeOtelBaggageKey (key) {
    let encoded = encodeURIComponent(key)
    encoded = encoded.replaceAll('(', '%28')
    encoded = encoded.replaceAll(')', '%29')
    return encoded
  }

  _injectBaggageItems (spanContext, carrier) {
    if (this._config.legacyBaggageEnabled) {
      spanContext._baggageItems && Object.keys(spanContext._baggageItems).forEach(key => {
        carrier[baggagePrefix + key] = String(spanContext._baggageItems[key])
      })
    }
    if (this._hasPropagationStyle('inject', 'baggage')) {
      let baggage = ''
      let itemCounter = 0
      let byteCounter = 0

      for (const [key, value] of Object.entries(spanContext._baggageItems)) {
        const item = `${this._encodeOtelBaggageKey(String(key).trim())}=${encodeURIComponent(String(value).trim())},`
        itemCounter += 1
        byteCounter += item.length
        if (itemCounter > this._config.baggageMaxItems || byteCounter > this._config.baggageMaxBytes) break
        baggage += item
      }

      baggage = baggage.slice(0, baggage.length - 1)
      if (baggage) carrier.baggage = baggage
    }
  }

  _injectTags (spanContext, carrier) {
    const trace = spanContext._trace

    if (this._config.tagsHeaderMaxLength === 0) {
      log.debug('Trace tag propagation is disabled, skipping injection.')
      return
    }

    const tags = []

    for (const key in trace.tags) {
      if (!trace.tags[key] || !key.startsWith('_dd.p.')) continue
      if (!this._validateTagKey(key) || !this._validateTagValue(trace.tags[key])) {
        log.error('Trace tags from span are invalid, skipping injection.')
        return
      }

      tags.push(`${key}=${trace.tags[key]}`)
    }

    const header = tags.join(',')

    if (header.length > this._config.tagsHeaderMaxLength) {
      log.error('Trace tags from span are too large, skipping injection.')
    } else if (header) {
      carrier[tagsKey] = header
    }
  }

  _injectB3MultipleHeaders (spanContext, carrier) {
    const hasB3 = this._hasPropagationStyle('inject', 'b3')
    const hasB3multi = this._hasPropagationStyle('inject', 'b3multi')
    if (!(hasB3 || hasB3multi)) return

    carrier[b3TraceKey] = this._getB3TraceId(spanContext)
    carrier[b3SpanKey] = spanContext._spanId.toString(16)
    carrier[b3SampledKey] = spanContext._sampling.priority >= AUTO_KEEP ? '1' : '0'

    if (spanContext._sampling.priority > AUTO_KEEP) {
      carrier[b3FlagsKey] = '1'
    }

    if (spanContext._parentId) {
      carrier[b3ParentKey] = spanContext._parentId.toString(16)
    }
  }

  _injectB3SingleHeader (spanContext, carrier) {
    const hasB3SingleHeader = this._hasPropagationStyle('inject', 'b3 single header')
    if (!hasB3SingleHeader) return null

    const traceId = this._getB3TraceId(spanContext)
    const spanId = spanContext._spanId.toString(16)
    const sampled = spanContext._sampling.priority >= AUTO_KEEP ? '1' : '0'

    carrier[b3HeaderKey] = `${traceId}-${spanId}-${sampled}`
    if (spanContext._parentId) {
      carrier[b3HeaderKey] += '-' + spanContext._parentId.toString(16)
    }
  }

  _injectTraceparent (spanContext, carrier) {
    if (!this._hasPropagationStyle('inject', 'tracecontext')) return

    const {
      _sampling: { priority, mechanism },
      _tracestate: ts = new TraceState(),
      _trace: { origin, tags }
    } = spanContext

    carrier[traceparentKey] = spanContext.toTraceparent()

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
          .replace(tracestateOriginFilter, '_')
          .replace(/[\x3d]/g, '~')

        state.set('o', originValue)
      }

      for (const key in tags) {
        if (!tags[key] || !key.startsWith('_dd.p.')) continue

        const tagKey = 't.' + key.slice(6)
          .replace(tracestateTagKeyFilter, '_')

        const tagValue = tags[key]
          .toString()
          .replace(tracestateTagValueFilter, '_')
          .replace(/[\x3d]/g, '~')

        state.set(tagKey, tagValue)
      }
    })

    carrier.tracestate = ts.toString()
  }

  _hasPropagationStyle (mode, name) {
    return this._config.tracePropagationStyle[mode].includes(name)
  }

  _hasTraceIdConflict (w3cSpanContext, firstSpanContext) {
    return w3cSpanContext !== null &&
           firstSpanContext.toTraceId(true) === w3cSpanContext.toTraceId(true) &&
           firstSpanContext.toSpanId() !== w3cSpanContext.toSpanId()
  }

  _hasParentIdInTags (spanContext) {
    return tags.DD_PARENT_ID in spanContext._trace.tags
  }

  _updateParentIdFromDdHeaders (carrier, firstSpanContext) {
    const ddCtx = this._extractDatadogContext(carrier)
    if (ddCtx !== null) {
      firstSpanContext._trace.tags[tags.DD_PARENT_ID] = ddCtx._spanId.toString().padStart(16, '0')
    }
  }

  _resolveTraceContextConflicts (w3cSpanContext, firstSpanContext, carrier) {
    if (!this._hasTraceIdConflict(w3cSpanContext, firstSpanContext)) {
      return firstSpanContext
    }
    if (this._hasParentIdInTags(w3cSpanContext)) {
      // tracecontext headers contain a p value, ensure this value is sent to backend
      firstSpanContext._trace.tags[tags.DD_PARENT_ID] = w3cSpanContext._trace.tags[tags.DD_PARENT_ID]
    } else {
      // if p value is not present in tracestate, use the parent id from the datadog headers
      this._updateParentIdFromDdHeaders(carrier, firstSpanContext)
    }
    // the span_id in tracecontext takes precedence over the first extracted propagation style
    firstSpanContext._spanId = w3cSpanContext._spanId
    return firstSpanContext
  }

  _extractSpanContext (carrier) {
    let context = null
    for (const extractor of this._config.tracePropagationStyle.extract) {
      let extractedContext = null
      switch (extractor) {
        case 'datadog':
          extractedContext = this._extractDatadogContext(carrier)
          break
        case 'tracecontext':
          extractedContext = this._extractTraceparentContext(carrier)
          break
        case 'b3 single header': // TODO: delete in major after singular "b3"
          extractedContext = this._extractB3SingleContext(carrier)
          break
        case 'b3':
          if (this._config.tracePropagationStyle.otelPropagators) {
            // TODO: should match "b3 single header" in next major
            extractedContext = this._extractB3SingleContext(carrier)
          } else {
            extractedContext = this._extractB3MultiContext(carrier)
          }
          break
        case 'b3multi':
          extractedContext = this._extractB3MultiContext(carrier)
          break
        default:
          if (extractor !== 'baggage') log.warn(`Unknown propagation style: ${extractor}`)
      }

      if (extractedContext === null) { // If the current extractor was invalid, continue to the next extractor
        continue
      }

      if (context === null) {
        context = extractedContext
        if (this._config.tracePropagationExtractFirst) {
          this._extractBaggageItems(carrier, context)
          return context
        }
      } else {
        // If extractor is tracecontext, add tracecontext specific information to the context
        if (extractor === 'tracecontext') {
          context = this._resolveTraceContextConflicts(
            this._extractTraceparentContext(carrier), context, carrier)
        }
        if (extractedContext._traceId && extractedContext._spanId &&
           extractedContext.toTraceId(true) !== context.toTraceId(true)) {
          const link = {
            context: extractedContext,
            attributes: { reason: 'terminated_context', context_headers: extractor }
          }
          context._links.push(link)
        }
      }
    }

    this._extractBaggageItems(carrier, context)

    return context || this._extractSqsdContext(carrier)
  }

  _extractDatadogContext (carrier) {
    const spanContext = this._extractGenericContext(carrier, traceKey, spanKey, 10)

    if (!spanContext) return spanContext

    this._extractOrigin(carrier, spanContext)
    this._extractLegacyBaggageItems(carrier, spanContext)
    this._extractSamplingPriority(carrier, spanContext)
    this._extractTags(carrier, spanContext)

    if (this._config.tracePropagationExtractFirst) return spanContext

    const tc = this._extractTraceparentContext(carrier)

    if (tc && spanContext._traceId.equals(tc._traceId)) {
      spanContext._traceparent = tc._traceparent
      spanContext._tracestate = tc._tracestate
    }

    return spanContext
  }

  _extractB3MultiContext (carrier) {
    const b3 = this._extractB3MultipleHeaders(carrier)
    if (!b3) return null
    return this._extractB3Context(b3)
  }

  _extractB3SingleContext (carrier) {
    if (!b3HeaderExpr.test(carrier[b3HeaderKey])) return null
    const b3 = this._extractB3SingleHeader(carrier)
    if (!b3) return null
    return this._extractB3Context(b3)
  }

  _extractB3Context (b3) {
    const debug = b3[b3FlagsKey] === '1'
    const priority = this._getPriority(b3[b3SampledKey], debug)
    const spanContext = this._extractGenericContext(b3, b3TraceKey, b3SpanKey, 16)

    if (priority !== undefined) {
      if (!spanContext) {
        // B3 can force a sampling decision without providing IDs
        return new DatadogSpanContext({
          traceId: id(),
          spanId: null,
          sampling: { priority },
          isRemote: true
        })
      }

      spanContext._sampling.priority = priority
    }

    this._extract128BitTraceId(b3[b3TraceKey], spanContext)

    return spanContext
  }

  _extractSqsdContext (carrier) {
    const headerValue = carrier[sqsdHeaderHey]
    if (!headerValue) {
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(headerValue)
    } catch (e) {
      return null
    }
    return this._extractDatadogContext(parsed)
  }

  _extractTraceparentContext (carrier) {
    const headerValue = carrier[traceparentKey]
    if (!headerValue) {
      return null
    }
    const matches = headerValue.trim().match(traceparentExpr)
    if (matches?.length) {
      const [version, traceId, spanId, flags, tail] = matches.slice(1)
      const traceparent = { version }
      const tracestate = TraceState.fromString(carrier.tracestate)
      if (invalidSegment.test(traceId)) return null
      if (invalidSegment.test(spanId)) return null

      // Version ff is considered invalid
      if (version === 'ff') return null

      // Version 00 should have no tail, but future versions may
      if (tail && version === '00') return null

      const spanContext = new DatadogSpanContext({
        traceId: id(traceId, 16),
        spanId: id(spanId, 16),
        isRemote: true,
        sampling: { priority: parseInt(flags, 10) & 1 ? 1 : 0 },
        traceparent,
        tracestate
      })

      this._extract128BitTraceId(traceId, spanContext)

      tracestate.forVendor('dd', state => {
        for (const [key, value] of state.entries()) {
          switch (key) {
            case 'p': {
              spanContext._trace.tags[tags.DD_PARENT_ID] = value
              break
            }
            case 's': {
              const priority = parseInt(value, 10)
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
              spanContext._trace.origin = value
              break
            case 't.dm': {
              const mechanism = Math.abs(parseInt(value, 10))
              if (Number.isInteger(mechanism)) {
                spanContext._sampling.mechanism = mechanism
                spanContext._trace.tags['_dd.p.dm'] = `-${mechanism}`
              }
              break
            }
            default:
              if (!key.startsWith('t.')) continue
              spanContext._trace.tags[`_dd.p.${key.slice(2)}`] = value
                .replace(/[\x7e]/gm, '=')
          }
        }
      })

      this._extractLegacyBaggageItems(carrier, spanContext)
      return spanContext
    }
    return null
  }

  _extractGenericContext (carrier, traceKey, spanKey, radix) {
    if (carrier && carrier[traceKey] && carrier[spanKey]) {
      if (invalidSegment.test(carrier[traceKey])) return null

      return new DatadogSpanContext({
        traceId: id(carrier[traceKey], radix),
        spanId: id(carrier[spanKey], radix),
        isRemote: true
      })
    }

    return null
  }

  _extractB3MultipleHeaders (carrier) {
    let empty = true
    const b3 = {}

    if (b3TraceExpr.test(carrier[b3TraceKey]) && b3SpanExpr.test(carrier[b3SpanKey])) {
      b3[b3TraceKey] = carrier[b3TraceKey]
      b3[b3SpanKey] = carrier[b3SpanKey]
      empty = false
    }

    if (carrier[b3SampledKey]) {
      b3[b3SampledKey] = carrier[b3SampledKey]
      empty = false
    }

    if (carrier[b3FlagsKey]) {
      b3[b3FlagsKey] = carrier[b3FlagsKey]
      empty = false
    }

    return empty ? null : b3
  }

  _extractB3SingleHeader (carrier) {
    const header = carrier[b3HeaderKey]
    if (!header) return null

    const parts = header.split('-')

    if (parts[0] === 'd') {
      return {
        [b3SampledKey]: '1',
        [b3FlagsKey]: '1'
      }
    } else if (parts.length === 1) {
      return {
        [b3SampledKey]: parts[0]
      }
    } else {
      const b3 = {
        [b3TraceKey]: parts[0],
        [b3SpanKey]: parts[1]
      }

      if (parts[2]) {
        b3[b3SampledKey] = parts[2] !== '0' ? '1' : '0'

        if (parts[2] === 'd') {
          b3[b3FlagsKey] = '1'
        }
      }

      return b3
    }
  }

  _extractOrigin (carrier, spanContext) {
    const origin = carrier[originKey]

    if (typeof carrier[originKey] === 'string') {
      spanContext._trace.origin = origin
    }
  }

  _decodeOtelBaggageKey (key) {
    let decoded = decodeURIComponent(key)
    decoded = decoded.replaceAll('%28', '(')
    decoded = decoded.replaceAll('%29', ')')
    return decoded
  }

  _extractLegacyBaggageItems (carrier, spanContext) {
    if (this._config.legacyBaggageEnabled) {
      Object.keys(carrier).forEach(key => {
        const match = key.match(baggageExpr)

        if (match) {
          spanContext._baggageItems[match[1]] = carrier[key]
        }
      })
    }
  }

  _extractBaggageItems (carrier, spanContext) {
    if (!this._hasPropagationStyle('extract', 'baggage')) return
    if (!carrier || !carrier.baggage) return
    if (!spanContext) return
    const baggages = carrier.baggage.split(',')
    for (const keyValue of baggages) {
      if (!keyValue.includes('=')) {
        spanContext._baggageItems = {}
        return
      }
      let [key, value] = keyValue.split('=')
      key = this._decodeOtelBaggageKey(key.trim())
      value = decodeURIComponent(value.trim())
      if (!key || !value) {
        spanContext._baggageItems = {}
        return
      }
      // the current code assumes precedence of ot-baggage- (legacy opentracing baggage) over baggage
      if (key in spanContext._baggageItems) return
      spanContext._baggageItems[key] = value
    }
  }

  _extractSamplingPriority (carrier, spanContext) {
    const priority = parseInt(carrier[samplingKey], 10)

    if (Number.isInteger(priority)) {
      spanContext._sampling.priority = priority
    }
  }

  _extractTags (carrier, spanContext) {
    if (!carrier[tagsKey]) return

    const trace = spanContext._trace

    if (this._config.tagsHeaderMaxLength === 0) {
      log.debug('Trace tag propagation is disabled, skipping extraction.')
    } else if (carrier[tagsKey].length > this._config.tagsHeaderMaxLength) {
      log.error('Trace tags from carrier are too large, skipping extraction.')
    } else {
      const pairs = carrier[tagsKey].split(',')
      const tags = {}

      for (const pair of pairs) {
        const [key, ...rest] = pair.split('=')
        const value = rest.join('=')

        if (!this._validateTagKey(key) || !this._validateTagValue(value)) {
          log.error('Trace tags from carrier are invalid, skipping extraction.')
          return
        }

        tags[key] = value
      }

      Object.assign(trace.tags, tags)
    }
  }

  _extract128BitTraceId (traceId, spanContext) {
    if (!spanContext) return

    const buffer = spanContext._traceId.toBuffer()

    if (buffer.length !== 16) return

    const tid = traceId.substring(0, 16)

    if (tid === zeroTraceId) return

    spanContext._trace.tags['_dd.p.tid'] = tid
  }

  _validateTagKey (key) {
    return tagKeyExpr.test(key)
  }

  _validateTagValue (value) {
    return tagValueExpr.test(value)
  }

  _getPriority (sampled, debug) {
    if (debug) {
      return USER_KEEP
    } else if (sampled === '1') {
      return AUTO_KEEP
    } else if (sampled === '0') {
      return AUTO_REJECT
    }
  }

  _getB3TraceId (spanContext) {
    if (spanContext._traceId.toBuffer().length <= 8 && spanContext._trace.tags['_dd.p.tid']) {
      return spanContext._trace.tags['_dd.p.tid'] + spanContext._traceId.toString(16)
    }

    return spanContext._traceId.toString(16)
  }

  static _convertOtelContextToDatadog (traceId, spanId, traceFlag, ts, meta = {}) {
    const origin = null
    let samplingPriority = traceFlag

    ts = ts?.traceparent || null

    if (ts) {
      // Use TraceState.fromString to parse the tracestate header
      const traceState = TraceState.fromString(ts)
      let ddTraceStateData = null

      // Extract Datadog specific trace state data
      traceState.forVendor('dd', (state) => {
        ddTraceStateData = state
        return state // You might need to adjust this part based on actual logic needed
      })

      if (ddTraceStateData) {
        // Assuming ddTraceStateData is now a Map or similar structure containing Datadog trace state data
        // Extract values as needed, similar to the original logic
        const samplingPriorityTs = ddTraceStateData.get('s')
        const origin = ddTraceStateData.get('o')
        // Convert Map to object for meta
        const otherPropagatedTags = Object.fromEntries(ddTraceStateData.entries())

        // Update meta and samplingPriority based on extracted values
        Object.assign(meta, otherPropagatedTags)
        samplingPriority = TextMapPropagator._getSamplingPriority(traceFlag, parseInt(samplingPriorityTs, 10), origin)
      } else {
        log.debug(`no dd list member in tracestate from incoming request: ${ts}`)
      }
    }

    const spanContext = new OtelSpanContext({
      traceId: id(traceId, 16), spanId: id(), tags: meta, parentId: id(spanId, 16)
    })

    spanContext._sampling = { priority: samplingPriority }
    spanContext._trace = { origin }
    return spanContext
  }

  static _getSamplingPriority (traceparentSampled, tracestateSamplingPriority, origin = null) {
    const fromRumWithoutPriority = !tracestateSamplingPriority && origin === 'rum'

    let samplingPriority
    if (!fromRumWithoutPriority && traceparentSampled === 0 &&
    (!tracestateSamplingPriority || tracestateSamplingPriority >= 0)) {
      samplingPriority = 0
    } else if (!fromRumWithoutPriority && traceparentSampled === 1 &&
    (!tracestateSamplingPriority || tracestateSamplingPriority < 0)) {
      samplingPriority = 1
    } else {
      samplingPriority = tracestateSamplingPriority
    }

    return samplingPriority
  }
}

module.exports = TextMapPropagator
