const log = require('./log')
const TextMapPropagator = require('./opentracing/propagation/text_map')
const traceContextInjector = new TextMapPropagator({ tracePropagationStyle: { inject: 'tracecontext' } })

const ALLOWED = ['string', 'number', 'boolean']
const ALLOWED_SPAN_LINKS_KEY = [ 'trace_id', 'span_id', 'attributes',
  'dropped_attributes_count', 'tracestate', 'trace_id_high', 'flags']

function sanitizeAttributes (formattedLink, attributes) {
  let _attributesString = '{'

  const addArrayorScalarAttributes = (key, maybeArray) => {
    if (Array.isArray(maybeArray)) {
      for (const subkey in maybeArray) {
        addArrayorScalarAttributes(`${key}.${subkey}`, maybeArray[subkey])
      }
    } else {
      const maybeScalar = maybeArray
      if (ALLOWED.includes(typeof maybeScalar)) {
        formattedLink.attributesCount++
        if (_attributesString.length === 1) { // no attributes yet
          _attributesString += `"${key}":"${maybeScalar}"}`
        } else {
          _attributesString = _attributesString.slice(0, -1) + `,"${key}":"${maybeScalar}"}`
        }
      } else {
        log.warn(`Dropping span link attribute.`)
        formattedLink.dropped_attributes_count++
      }
    }
  }

  Object
    .entries(attributes)
    .forEach(entry => {
      const [key, value] = entry
      addArrayorScalarAttributes(key, value)
    })

  return `${_attributesString}`
}

function getTraceFlags (spanContext, context, formattedLink) {
  // _tracestate only set when w3c trace flags are given
  if (spanContext?._tracestate) {
    formattedLink.flags = spanContext._sampling.priority > 0 ? 1 : 0
  }

  if (context?._tracestate) {
    formattedLink.flags = context._sampling.priority > 0 ? 1 : 0
  }
}

function formatLink (spanContext, context, attributes = {}) {
  const formattedLink = {
    trace_id: context._traceId.toString(),
    span_id: context._spanId.toString(),
    dropped_attributes_count: 0,
    attributesCount: 0
  }
  formattedLink.attributes = sanitizeAttributes(formattedLink, attributes)

  if (!context._traceId.equals(spanContext._traceId)) return formattedLink

  getTraceFlags(spanContext, context, formattedLink)

  formattedLink.trace_id_high = context?._trace.tags['_dd.p.tid'] || spanContext?._trace.tags['_dd.p.tid']
  formattedLink.tracestate = context?._tracestate || spanContext?._tracestate

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

function spanLinkLength (link, linkString) {
  const droppedAttributesString = link.dropped_attributes_count > 0
    ? `"dropped_attributes_count":"${link.dropped_attributes_count}",` : ''
  return Buffer.byteLength(linkString) +
         Buffer.byteLength(link.attributes) +
         Buffer.byteLength(droppedAttributesString)
}

function spanLinkToString (link) {
  let encoded = `{`
  for (const [key, value] of Object.entries(link)) {
    if (!(ALLOWED_SPAN_LINKS_KEY.includes(key)) || value === undefined) continue
    else if (key === 'attributes') encoded += link.attributesCount > 0 ? `"${key}":${value},` : ''
    else if (key === 'flags') encoded += `"${key}":${value},`
    else if (key === 'dropped_attributes_count') {
      encoded += link.dropped_attributes_count > 0
        ? `"dropped_attributes_count":"${link.dropped_attributes_count}",` : ''
    } else encoded += `"${key}":"${value}",`
  }
  return encoded.slice(0, -1) + '}'
}

module.exports = {
  formatLink,
  spanLinkLength,
  spanLinkToString
}
