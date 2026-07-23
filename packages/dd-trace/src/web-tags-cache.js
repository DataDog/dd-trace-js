'use strict'

// Per-span cache of "which tag bag from the started-spans chain identifies
// this span (or its nearest web-server ancestor) as a web-server span?"
// Populated lazily on first `getCachedWebTags(span)`, refreshed
// automatically when a `dd-trace:span:tags:update` event promotes a
// previously-empty answer for that span into a real value.
//
// Used by the wall profiler (endpoint-collection label on samples) and by
// the OTEP-4947 thread-context writer (endpoint attribute in the record);
// having a single cache means the parent-chain walk happens once per span
// no matter how many consumers ask.
//
// Consumers that want to react to late web-server-span discovery
// subscribe to `resolvedCh` — a diagnostics channel we publish on once
// per span at the moment its cached webTags transitions from undefined
// to a real value. Doing it via a channel (rather than exposing a
// stateful "did the transition happen?" query) means each consumer sees
// every transition exactly once, regardless of subscription order or
// how many other consumers are attached.

const dc = require('dc-polyfill')
const { isWebServerSpan, getStartedSpans } = require('./profiling/webspan-utils')

// Fields on the cache entry:
//   resolved: true once the parent-chain walk has run.
//   webTags:  the resolved tag bag, or undefined when the walk came up
//             empty (no web-server span found in the started-spans chain).
const CachedSym = Symbol('WebTagsCache')

const tagsUpdateCh = dc.channel('dd-trace:span:tags:update')
const resolvedCh = dc.channel('dd-trace:web-tags:resolved')

function getCache (span) {
  let cached = span[CachedSym]
  if (cached === undefined) {
    cached = {}
    span[CachedSym] = cached
  }
  return cached
}

// Returns the web-server tag bag for this span or its nearest web-server
// ancestor in the started-spans chain, or undefined if none is a
// web-server span. Lazy: walks the parent chain on the first call, caches
// the result on the span.
function getCachedWebTags (span) {
  const cached = getCache(span)
  if (cached.resolved) return cached.webTags
  const spanContext = span.context()
  const tags = spanContext.getTags()
  let webTags
  if (isWebServerSpan(tags)) {
    webTags = tags
  } else {
    const parentId = spanContext._parentId
    const startedSpans = getStartedSpans(spanContext)
    for (let i = startedSpans.length; --i >= 0;) {
      const ispan = startedSpans[i]
      if (ispan.context()._spanId === parentId) {
        webTags = getCachedWebTags(ispan)
        break
      }
    }
  }
  cached.webTags = webTags
  cached.resolved = true
  return webTags
}

// Own the tagsUpdate → transition promotion here. Subscribed at module
// load; inert (an O(1) Symbol check) for any span nobody has queried yet.
tagsUpdateCh.subscribe((span) => {
  const cached = span[CachedSym]
  if (cached === undefined || !cached.resolved || cached.webTags !== undefined) return
  const tags = span.context().getTags()
  if (!isWebServerSpan(tags)) return
  cached.webTags = tags
  resolvedCh.publish(span)
})

module.exports = { getCachedWebTags, resolvedCh }
