'use strict'

const { HTTP_METHOD, HTTP_ROUTE, RESOURCE_NAME, SPAN_TYPE } = require('../../../../ext/tags')
const { WEB } = require('../../../../ext/types')

function isWebServerSpan (tags) {
  return tags[SPAN_TYPE] === WEB
}

function endpointNameFromTags (tags) {
  return tags[RESOURCE_NAME] || [
    tags[HTTP_METHOD],
    tags[HTTP_ROUTE],
  ].filter(Boolean).join(' ')
}

// The endpoint name a web-server span's tag bag yields changes over the span's
// lifetime: plugins set `http.method` when the request arrives and only add
// `http.route` (and often `resource.name`) once framework routing has resolved
// the URL. Returns the endpoint name once its value looks stable, or undefined
// while it is still an interim placeholder.
//
// Consumers that read the tag bag lazily (the wall profiler resolves endpoint
// labels at serialization time) see the settled value for free and only need
// this for fallbacks captured mid-request. Consumers that have to materialize
// the value early — the OTEP-4947 thread-context writer writes it into a record
// an out-of-process reader samples at any moment — need it to decide when
// publishing is safe.
//
// The test is on the computed value rather than on which tags are present,
// because endpointNameFromTags prefers `resource.name` over
// `http.method` + `http.route` and some plugins seed `resource.name` with the
// bare request method before routing resolves: datadog-plugin-next starts its
// request span with `resource.name: req.method` and only replaces it with
// `${req.method} ${page}` once the page is known. A value equal to the bare
// method is therefore a placeholder no matter which tags produced it.
function finalEndpoint (tags) {
  if (tags == null) return
  // Presence gate first: nothing but these two can contribute routing
  // information, and checking them keeps the common not-yet-routed case free of
  // the string building inside endpointNameFromTags.
  if (tags[RESOURCE_NAME] == null && tags[HTTP_ROUTE] == null) return
  const endpoint = endpointNameFromTags(tags)
  if (!endpoint || endpoint === tags[HTTP_METHOD]) return
  return endpoint
}

// The trace's started-spans list, whose first entry is the local root span by
// repo-wide convention — priority_sampler, span_format, the wall profiler's
// local-root-span-id label, the event plugins and the OTEP-4947 writer all read
// it that way, and web-tags-cache walks it to find a span's parent.
//
// Partial flush weakens that convention for every one of them alike:
// span_processor's _erase() replaces the list with the still-active spans only,
// so once a trace crosses DD_TRACE_PARTIAL_FLUSH_MIN_SPANS a local root that has
// already finished drops out, and the first entry becomes merely the oldest span
// still running — while a finished web-server ancestor stops being reachable for
// the parent-chain walk. Correcting it needs a local-root reference the tracer
// core keeps across flushes; until there is one, consumers share the same skew
// on large traces rather than each compensating differently.
function getStartedSpans (context) {
  return context._trace.started
}

module.exports = {
  isWebServerSpan,
  endpointNameFromTags,
  finalEndpoint,
  getStartedSpans,
}
