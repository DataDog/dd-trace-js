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
//
// `endpointResolvedCh` is the same idea one field over: published once per
// web-server span at the moment its endpoint name settles (see finalEndpoint in
// profiling/webspan-utils.js), i.e. when routing tags stop being interim
// placeholders. Consumers that must materialize the endpoint eagerly rather
// than read the tag bag at leisure need that moment; owning it here means the
// one `dd-trace:span:tags:update` subscription this module already holds serves
// them too, instead of each consumer adding its own subscriber to that hot
// channel and re-deriving finality itself.
//
// The module-level `dd-trace:span:tags:update` subscription that drives
// the transition promotion is installed lazily via `activate()` /
// `deactivate()`, ref-counted across consumers. When no consumer has
// activated the cache, `dd-trace:span:tags:update` stays subscriber-free
// so `DatadogSpan#setTag` / `addTags` skip the publish path entirely.
// Consumers MUST balance every activate() call with a matching
// deactivate() when they stop caring.

const dc = require('dc-polyfill')
const { getOwnWebTags, getParentSpan } = require('./opentracing/span-projections')
const { finalEndpoint, isWebServerSpan } = require('./profiling/webspan-utils')

// Fields on the cache entry:
//   resolved:      true once the parent-chain walk has run.
//   webTags:       the resolved tag bag, or undefined when the walk came up
//                  empty (no web-server span found in the started-spans chain).
//   endpointFinal: true once this span is a web-server span whose endpoint name
//                  has settled and endpointResolvedCh has been published for it.
const cache = new WeakMap()

const tagsUpdateCh = dc.channel('dd-trace:span:tags:update')
const resolvedCh = dc.channel('dd-trace:web-tags:resolved')
const endpointResolvedCh = dc.channel('dd-trace:web-tags:endpoint-resolved')

function getCache (span) {
  let cached = cache.get(span)
  if (cached === undefined) {
    cached = {}
    cache.set(span, cached)
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
  const tags = getOwnWebTags(span)
  let webTags
  if (isWebServerSpan(tags)) {
    webTags = tags
  } else {
    const parent = getParentSpan(span)
    if (parent !== undefined) webTags = getCachedWebTags(parent)
  }
  cached.webTags = webTags
  cached.resolved = true
  return webTags
}

// Own the tagsUpdate → transition promotion here. The dc subscribe
// happens lazily via activate(); each active consumer bumps a refcount,
// the last deactivate() removes the subscription. When idle, this module
// contributes no subscribers to `dd-trace:span:tags:update`, so
// `DatadogSpan#setTag` / `addTags` never enter the publish path on our
// behalf.
function onTagsUpdate (span) {
  const cached = cache.get(span)
  if (cached === undefined || !cached.resolved) return
  const tags = getOwnWebTags(span)
  if (cached.webTags === undefined) {
    if (!isWebServerSpan(tags)) return
    cached.webTags = tags
    resolvedCh.publish(span)
  }
  // Endpoint finality is a property of the web-server span itself: for a
  // descendant, cached.webTags is an ancestor's bag rather than these tags, and
  // the ancestor's own update is what settles the endpoint. Skipped entirely
  // when nobody is listening, keeping this the same early return it used to be
  // for consumers that only care about web-tag discovery.
  if (!endpointResolvedCh.hasSubscribers || cached.endpointFinal || cached.webTags !== tags) return
  if (finalEndpoint(tags) === undefined) return
  cached.endpointFinal = true
  endpointResolvedCh.publish(span)
}

let activeCount = 0

function activate () {
  if (activeCount++ === 0) {
    tagsUpdateCh.subscribe(onTagsUpdate)
  }
}

function deactivate () {
  if (activeCount === 0) return
  if (--activeCount === 0) {
    tagsUpdateCh.unsubscribe(onTagsUpdate)
  }
}

module.exports = { getCachedWebTags, resolvedCh, endpointResolvedCh, activate, deactivate }
