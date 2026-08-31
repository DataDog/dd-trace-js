'use strict'

// Per-span cache of "which tag bag from the started-spans chain identifies
// this span (or its nearest web-server ancestor) as a web-server span?"
// Populated lazily on first `getCachedWebTags(span)`, refreshed
// automatically when a `dd-trace:span:tags:update` event turns a span into a
// web-server span after the fact — for that span and for every descendant
// whose answer the promotion changes.
//
// Used by the wall profiler (endpoint-collection label on samples) and by
// the OTEP-4947 thread-context writer (endpoint attribute in the record);
// having a single cache means the parent-chain walk happens once per span
// no matter how many consumers ask.
//
// Consumers that want to react to late web-server-span discovery
// subscribe to `resolvedCh` — a diagnostics channel we publish on once
// per span at the moment its cached webTags changes, i.e. when a promotion
// gives it an answer it didn't have or replaces the one it had with a
// nearer one. Doing it via a channel (rather than exposing a stateful "did
// the transition happen?" query) means each consumer sees every transition
// exactly once, regardless of subscription order or how many other
// consumers are attached.
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
const { finalEndpoint, isWebServerSpan, getStartedSpans } = require('./profiling/webspan-utils')

// Fields on the cache entry:
//   resolved:      true once the parent-chain walk has run.
//   webTags:       the resolved tag bag, or undefined when the walk came up
//                  empty (no web-server span found in the started-spans chain).
//   endpointFinal: true once this span is a web-server span whose endpoint name
//                  has settled and endpointResolvedCh has been published for it.
const CachedSym = Symbol('WebTagsCache')

const tagsUpdateCh = dc.channel('dd-trace:span:tags:update')
const resolvedCh = dc.channel('dd-trace:web-tags:resolved')
const endpointResolvedCh = dc.channel('dd-trace:web-tags:endpoint-resolved')

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
// the result on the span. Answers only ever change through onTagsUpdate, which
// rewrites the affected entries in place, so a resolved answer is never
// revisited here.
function getCachedWebTags (span) {
  const cached = getCache(span)
  if (cached.resolved) return cached.webTags
  const spanContext = span.context()
  const tags = spanContext.getTags()
  const parentId = spanContext._parentId
  let webTags
  if (isWebServerSpan(tags)) {
    webTags = tags
  // A span with no parent has nothing to inherit from, and looking for one
  // anyway means scanning the entire started-spans list to conclude that.
  } else if (parentId != null) {
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

// Own the tagsUpdate → transition promotion here. The dc subscribe
// happens lazily via activate(); each active consumer bumps a refcount,
// the last deactivate() removes the subscription. When idle, this module
// contributes no subscribers to `dd-trace:span:tags:update`, so
// `DatadogSpan#setTag` / `addTags` never enter the publish path on our
// behalf.
function onTagsUpdate (span) {
  const cached = span[CachedSym]
  if (cached === undefined || !cached.resolved) return
  const spanContext = span.context()
  const tags = spanContext.getTags()
  // Anything but this span's own bag is an answer that predates it being a
  // web-server span: either empty, or an outer web-server ancestor's bag that
  // this span now supersedes for itself and for its descendants. A span whose
  // cached answer already is its own bag is the overwhelmingly common case here
  // (every further tag update on a request span), and stops at one comparison.
  if (cached.webTags !== tags && isWebServerSpan(tags)) {
    cached.webTags = tags
    resolvedCh.publish(span)
    resolveDescendants(span, spanContext, tags)
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

// A span has just become a web-server span; answers cached for its descendants
// before that moment found a farther ancestor or nothing at all, and are now
// wrong. Rewrite them here rather than letting each descendant discover it on
// its next lookup: a descendant that is already active keeps handing samplers
// its stale answer for as long as it runs without re-entering storage, which is
// precisely the uninterrupted synchronous stretch profiling cares about.
//
// One forward pass over the trace's started-spans list, which is in creation
// order, so a span's parent always precedes it: `answers` holds the new answer
// for each span in the promoted span's subtree, keyed by span id, and a span
// inherits its parent's unless it is a web-server span itself, in which case its
// own bag shadows the promotion for its own subtree. Spans outside the subtree
// are never in `answers`, so they cost one map lookup and nothing else.
//
// That same creation order means nothing before the promoted span can be a
// descendant of it, so the pass starts just past it. Locating it from the end
// costs one comparison in the common case, where a request span is promoted as
// it is created and is still the newest entry — leaving nothing to visit and
// nothing to allocate. A span the list no longer holds (finished, and dropped by
// a partial flush) ends that scan at -1, which visits the whole list.
function resolveDescendants (span, spanContext, webTags) {
  const startedSpans = getStartedSpans(spanContext)
  let index = startedSpans.length - 1
  while (index >= 0 && startedSpans[index] !== span) index--
  index++
  if (index === startedSpans.length) return
  const answers = new Map([[spanContext._spanId, webTags]])
  for (; index < startedSpans.length; index++) {
    const descendant = startedSpans[index]
    const context = descendant.context()
    const inherited = answers.get(context._parentId)
    if (inherited === undefined) continue
    const tags = context.getTags()
    const answer = isWebServerSpan(tags) ? tags : inherited
    answers.set(context._spanId, answer)
    const cached = descendant[CachedSym]
    if (cached === undefined || !cached.resolved || cached.webTags === answer) continue
    cached.webTags = answer
    resolvedCh.publish(descendant)
  }
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
