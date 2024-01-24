const log = require('./log')
const TextMapPropagator = require('./opentracing/propagation/text_map')
const traceContextInjector = new TextMapPropagator({ tracePropagationStyle: { inject: 'tracecontext' } })

const MAX_SPAN_LINKS_LENGTH = 25000

function sanitizeSpanLinkAttributes (link, attributes) {
  const allowed = ['string', 'number', 'boolean']

  let _attributesString = '{'

  const addArrayorScalarAttributes = (key, maybeArray) => {
    if (Array.isArray(maybeArray)) {
      for (const subkey in maybeArray) {
        addArrayorScalarAttributes(`${key}.${subkey}`, maybeArray[subkey])
      }
    } else {
      const maybeScalar = maybeArray
      if (allowed.includes(typeof maybeScalar)) {
        link.attributesCount++
        if (_attributesString.length === 1) { // no attributes yet
          _attributesString += `"${key}":"${maybeScalar}"}`
        } else {
          _attributesString = _attributesString.slice(0, -1) + `,"${key}":"${maybeScalar}"}`
        }
      } else {
        log.warn(`Dropping span link attribute.`)
        link.droppedAttributesCount++
      }
    }
  }

  Object
    .entries(attributes)
    .forEach(entry => {
      const [key, value] = entry
      addArrayorScalarAttributes(key, value)
    })

  return `"attributes":${_attributesString},`
}

function partialToString (formattedLink) {
  const link = {}

  // these values are always added
  if (formattedLink.traceIdHigh) {
    link.trace_id = formattedLink.traceIdHigh + formattedLink.traceId.toString()
    link.trace_id_high = formattedLink.traceIdHigh
  } else {
    link.trace_id = formattedLink.traceId.toString()
  }
  link.span_id = formattedLink.spanId.toString()

  // these values are conditionally added
  if (formattedLink.tracestate) link.tracestate = formattedLink.tracestate.toString()
  if (!isNaN(Number(formattedLink.flags))) link.flags = formattedLink.flags // 0 is a valid flag, but undefined is not

  return JSON.stringify(link)
}

function formatLink (spanContext, context, attributes = {}) {
  const formattedLink = {}
  formattedLink.traceId = context._traceId || spanContext._traceId
  formattedLink.spanId = context._spanId || spanContext._spanId
  formattedLink.droppedAttributesCount = 0
  formattedLink.attributesCount = 0
  formattedLink.attributes = sanitizeSpanLinkAttributes(formattedLink, attributes)

  const sameTrace = spanContext && context._traceId.equals(spanContext._traceId)
  formattedLink.partiallyEncodedString = partialToString(formattedLink)
  if (!sameTrace) return formattedLink
  // _tracestate only set when w3c trace flags are given
  let maybeTraceFlags
  if (spanContext?._tracestate) {
    maybeTraceFlags = spanContext._sampling.priority > 0 ? 1 : 0
  }
  const flags = context._flags ?? maybeTraceFlags
  const traceIdHigh = context?._trace.tags['_dd.p.tid'] || spanContext?._trace.tags['_dd.p.tid']
  console.log(55, traceIdHigh)
  let tracestate = context._tracestate || spanContext?._tracestate

  if (!tracestate && spanContext?._trace?.origin) {
    // inject extracted Datadog HTTP headers into local tracestate
    // indicated by _trace.origin
    const extractedTracestate = {}
    traceContextInjector.inject(spanContext, extractedTracestate)
    tracestate = extractedTracestate.tracestate
  }

  formattedLink.flags = flags
  formattedLink.traceIdHigh = traceIdHigh
  formattedLink.tracestate = tracestate
  formattedLink.partiallyEncodedString = partialToString(formattedLink)
  return formattedLink
}

function droppedAttributesCountToString (droppedAttributesCount) {
  if (!droppedAttributesCount) return '' // don't include if 0
  return `"dropped_attributes_count":"${droppedAttributesCount}",`
}

function spanLinkLength (partiallyEncodedString, attributes, droppedAttributesCount) {
  return (
    Buffer.byteLength(partiallyEncodedString) +
    Buffer.byteLength(attributes) +
    Buffer.byteLength(droppedAttributesCountToString(droppedAttributesCount))
  )
}

function spanLinkFlushAttributes (link) {
  link.droppedAttributesCount += link.attributesCount
  link.attributesCount = 0
  link.attributes = '{'
}

function spanLinkToString (link) {
  let encoded = link.partiallyEncodedString.slice(0, -1) + ','

  if (link.attributesCount > 0) {
    encoded += link.attributes
  }
  if (link.droppedAttributesCount > 0) {
    encoded += droppedAttributesCountToString(link.droppedAttributesCount)
  }
  return encoded.slice(0, -1) + '}' // replace trailing comma
}

function handleSpanLinks (links, context, attributes = {}, spanContext) {
  const link = formatLink(spanContext, context, attributes)
  let linksString = links.join() // Convert array elements to a string

  if ((Buffer.byteLength(linksString) +
        spanLinkLength(link.partiallyEncodedString, link.attributes, link.droppedAttributesCount)) >=
        MAX_SPAN_LINKS_LENGTH) {
    spanLinkFlushAttributes(link)
  }
  linksString = links.join() // Update the string after possible flushing
  if ((Buffer.byteLength(linksString) +
      spanLinkLength(link.partiallyEncodedString, link.attributes, link.droppedAttributesCount)) <
      MAX_SPAN_LINKS_LENGTH) {
    links.push(spanLinkToString(link))
  }
}

module.exports = {
  formatLink,
  spanLinkLength,
  spanLinkFlushAttributes,
  spanLinkToString,
  handleSpanLinks
}
