const log = require('./log')
const TextMapPropagator = require('./opentracing/propagation/text_map')
const traceContextInjector = new TextMapPropagator({ tracePropagationStyle: { inject: 'tracecontext' } })

const ALLOWED = ['string', 'number', 'boolean']
const ALLOWED_SPAN_LINKS_KEY = [ 'trace_id', 'span_id', 'attributes',
  'dropped_attributes_count', 'tracestate', 'trace_id_high', 'flags']

function sanitizeAttributes (formattedLink, attributes) {
  const sanitizedAttributes = {}

  const addArrayOrScalarAttributes = (key, maybeArray) => {
    if (Array.isArray(maybeArray)) {
      for (const subkey in maybeArray) {
        addArrayOrScalarAttributes(`${key}.${subkey}`, maybeArray[subkey])
      }
    } else {
      const maybeScalar = maybeArray
      if (ALLOWED.includes(typeof maybeScalar)) {
        formattedLink.attributesCount++
        // Wrap the value as a string if it's not already a string
        sanitizedAttributes[key] = typeof maybeScalar === 'string' ? maybeScalar : String(maybeScalar)
      } else {
        log.warn(`Dropping span link attribute.`)
        formattedLink.dropped_attributes_count++
      }
    }
  }

  Object.entries(attributes).forEach(entry => {
    const [key, value] = entry
    addArrayOrScalarAttributes(key, value)
  })

  return JSON.stringify(sanitizedAttributes)
}

function getTraceFlags (spanContext, linkContext, formattedLink) {
  // _tracestate only set when w3c trace flags are given
  if (spanContext?._tracestate) {
    formattedLink.flags = spanContext._sampling.priority > 0 ? 1 : 0
  }

  // take the linkContext's tracestate over the spanContext's if it exists
  if (linkContext?._tracestate) {
    formattedLink.flags = linkContext._sampling.priority > 0 ? 1 : 0
  }
}

function formatLink (spanContext, linkContext, attributes = {}) {
  const formattedLink = {
    trace_id: linkContext._traceId.toString(),
    span_id: linkContext._spanId.toString(),
    dropped_attributes_count: 0,
    attributesCount: 0
  }
  formattedLink.attributes = sanitizeAttributes(formattedLink, attributes)

  if (!linkContext._traceId.equals(spanContext._traceId)) return formattedLink

  getTraceFlags(spanContext, linkContext, formattedLink)

  formattedLink.trace_id_high = linkContext?._trace.tags['_dd.p.tid'] || spanContext?._trace.tags['_dd.p.tid']
  formattedLink.tracestate = linkContext?._tracestate || spanContext?._tracestate

  // inject extracted Datadog HTTP headers into local tracestate
  // indicated by _trace.origin
  if (!formattedLink.tracestate && spanContext?._trace?.origin) {
    const extractedTracestate = {}
    traceContextInjector.inject(spanContext, extractedTracestate)
    formattedLink.tracestate = extractedTracestate.tracestate
  }

  return {
    ...formattedLink,
    trace_id: formattedLink.trace_id_high
      ? formattedLink.trace_id_high + formattedLink.trace_id : formattedLink.trace_id,
    tracestate: formattedLink.tracestate?.toString()
  }
}

function spanLinkLength (formattedLink, formattedLinkString) {
  const droppedAttributesString = formattedLink.dropped_attributes_count > 0
    ? `"dropped_attributes_count":"${formattedLink.dropped_attributes_count}",` : ''
  return Buffer.byteLength(formattedLinkString) +
         Buffer.byteLength(formattedLink.attributes) +
         Buffer.byteLength(droppedAttributesString)
}

function spanLinkToString (formattedLink) {
  let encoded = `{`
  for (const [key, value] of Object.entries(formattedLink)) {
    if (!(ALLOWED_SPAN_LINKS_KEY.includes(key)) || value === undefined) continue
    else if (key === 'attributes') encoded += formattedLink.attributesCount > 0 ? `"${key}":${value},` : ''
    else if (key === 'flags') encoded += `"${key}":${value},`
    else if (key === 'dropped_attributes_count') {
      encoded += formattedLink.dropped_attributes_count > 0
        ? `"dropped_attributes_count":"${formattedLink.dropped_attributes_count}",` : ''
    } else encoded += `"${key}":"${value}",`
  }
  return encoded.slice(0, -1) + '}'
}

module.exports = {
  formatLink,
  spanLinkLength,
  spanLinkToString
}
