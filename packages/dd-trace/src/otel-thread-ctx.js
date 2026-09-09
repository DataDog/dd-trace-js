'use strict'

// OTEP-4947 Thread Local Context Record writer integration.
//
// Hooks into the active-span lifecycle (storage:enter, span:finish,
// span:tags:update channels) and mirrors the active trace ID, span ID
// and current endpoint into a thread-local record that an
// out-of-process eBPF reader can discover via the
// otel_thread_ctx_nodejs_v1 TLS symbol exported by the @datadog/pprof
// addon.
//
// Linux + AsyncContextFrame only. Degrades to a no-op start() on
// platforms or Node versions where the writer can't operate; the
// caller is expected to gate activation via the DD_TRACE_OTEL_CTX_ENABLED
// env var (or future config flag).
//
// Covers both the dd-trace API and the OpenTelemetry API when the
// latter is used through dd-trace-js's TracerProvider: an OTel Span
// wraps a DatadogSpan (packages/dd-trace/src/opentelemetry/span.js)
// and the OTel ContextManager activates spans via
// storage('legacy').run({ span: ddSpan }, ...), so the active span
// our writer reads from legacy storage is the same DatadogSpan in
// both cases. The OTel-visible trace/span IDs come from the same
// _ddContext.toTraceId/toSpanId calls we use here.

const { isMainThread, threadId } = require('worker_threads')

const { isACFActive } = require('../../datadog-core/src/storage')
const log = require('./log')
const {
  enterCh,
  spanFinishCh,
  getActiveSpan,
  ensureChannelsActivated,
} = require('./storage-channels')
const {
  finalEndpoint,
  getStartedSpans,
} = require('./profiling/webspan-utils')
const webTagsCache = require('./web-tags-cache')

// OTEP-4947 duplicates are last-wins, so appending a later endpoint value would
// correctly overwrite an earlier one — but an out-of-process reader sampling the
// record mid-request would still see the interim value (e.g. a bare `GET`) as
// the endpoint for whatever it was sampling. So a record is built without an
// endpoint until finalEndpoint (profiling/webspan-utils.js) reports the value
// settled, and gets one appended when webTagsCache announces that moment.
//
// Records still waiting on that announcement, grouped by the web-server tag bag
// they are waiting on. Every span under one request resolves to that same bag
// (webTagsCache maps a span to its nearest web-server ancestor's tags) and the
// endpoint belongs to the request rather than to any one span, so a single
// resolution fills in every record built before it — the request span's own and
// each descendant's. Descendants are the reason this can't just live on the
// per-span cache entry: the tags:update that carries the route is published for
// the ancestor, which has no way to enumerate them.
//
// Keyed by the tag bag itself because that is all a descendant has at build
// time, and the announcement carries the span whose getTags() is that same
// object. Tag-bag identity is stable for live spans — only spanleak.js replaces
// a bag, on already-expired spans under manual-GC debug mode — and webTagsCache
// already depends on it, holding bags the wall profiler dereferences much later.
//
// Entries are dropped as soon as the endpoint resolves, or die with the tag bag
// if it never does.
const pendingEndpoints = new WeakMap()

// Positional attribute layout. The local root span ID stays at index 0 by
// convention (mirrors libdatadog's libdd-otel-thread-ctx, where
// `local_root_span_id` is always the first entry in
// `threadlocal.attribute_key_map`), encoded as a 16-character lowercase
// hex string. Endpoint, thread name, and thread id follow. Adding more
// means assigning the next index and updating ATTRIBUTE_KEYS
// accordingly.
const LOCAL_ROOT_SPAN_ID_IDX = 0
const ENDPOINT_IDX = 1
const THREAD_NAME_IDX = 2
const THREAD_ID_IDX = 3

// The dd-trace-js-supplied subset of the OTEP-4719 attribute_key_map
// (the implicit `datadog.local_root_span_id` at wire index 0 is
// prepended by libdatadog when it publishes the process context, so it
// is NOT listed here). Index N here corresponds to wire key index N+1.
// Kept in sync with the positional indices above.
// Also see https://docs.google.com/document/d/1IwjjVJzEChcFPcnVV2N5Kkjg-4_Q4v4Q3ojpxntbdvY/edit?pli=1&tab=t.efaosgjya44c#bookmark=id.700gvw31vb7h
const ATTRIBUTE_KEYS = [
  'datadog.trace_endpoint',
  'datadog.thread_name',
  'datadog.thread_id',
]

// Stable per-thread values baked into every record. Same shape as the
// profiler's `eventLoopThreadName` in profiling/profilers/shared.js.
const THREAD_NAME = (isMainThread ? 'Main' : `Worker #${threadId}`) + ' Event Loop'
const THREAD_ID = String(threadId)

// Cache slot on span objects. One ThreadContext is built per span on first
// activation and re-installed across every async-context frame that
// re-enters the span — V8's AsyncContextFrame inherits the JS
// reference verbatim, and the context's record buffer is mutated in
// place by appendAttributes, so all frames observe the same record.
//
// Fields:
//   context:  ThreadContext from @datadog/pprof.otelThreadCtx — built the first
//             time onEnter activates the span, and cleared on span finish, which
//             is how a pendingEndpoints waiter recognizes a record it must no
//             longer append to.
//   webTags:  the web-server tag bag the record's endpoint comes from, or is
//             waiting on; undefined while the span has no web-server ancestry.
//             Distinguishes a stale announcement from a live one when a nearer
//             web-server span takes over.
const CachedSym = Symbol('OtelThreadCtx.cached')

let started = false
let ThreadContext
let getContext
let clearContext

function getOrBuildContext (span) {
  let cached = span[CachedSym]
  if (cached !== undefined && cached.context !== undefined) return cached.context
  const spanContext = span.context()
  const traceId = Uint8Array.from(Buffer.from(spanContext.toTraceId(true), 'hex'))
  const spanId = Uint8Array.from(Buffer.from(spanContext.toSpanId(true), 'hex'))
  // Local root span: the first entry in the trace's started-spans list, or
  // this span itself when it IS the root. Encoded as 16-char lowercase hex
  // per the libdatadog convention.
  const startedSpans = getStartedSpans(spanContext)
  const rootContext = startedSpans.length ? startedSpans[0].context() : spanContext
  // Only write the endpoint when its value has settled; otherwise leave a hole
  // and wait for webTagsCache to announce that it has.
  const webTags = webTagsCache.getCachedWebTags(span)
  const endpoint = finalEndpoint(webTags)
  const attrs = []
  attrs[LOCAL_ROOT_SPAN_ID_IDX] = rootContext.toSpanId(true)
  if (endpoint !== undefined) attrs[ENDPOINT_IDX] = endpoint
  attrs[THREAD_NAME_IDX] = THREAD_NAME
  attrs[THREAD_ID_IDX] = THREAD_ID
  if (cached === undefined) {
    cached = {}
    span[CachedSym] = cached
  }
  cached.context = new ThreadContext(traceId, spanId, attrs)
  cached.webTags = webTags
  if (endpoint === undefined) awaitEndpoint(webTags, cached)
  return cached.context
}

// Enlist a record built without an endpoint, so the resolution announcement for
// its request fills it in.
function awaitEndpoint (webTags, cached) {
  // No web-server span in this span's ancestry, so no endpoint is coming. Should
  // one appear later, webTagsCache announces that separately — see
  // onWebTagsResolved.
  if (webTags === undefined) return
  const waiting = pendingEndpoints.get(webTags)
  if (waiting === undefined) {
    pendingEndpoints.set(webTags, [cached])
  } else {
    waiting.push(cached)
  }
}

function appendEndpoint (context, endpoint) {
  // Append in place. The record buffer is shared across every async-context
  // frame holding this context, so the endpoint becomes visible everywhere at
  // once.
  const append = []
  append[ENDPOINT_IDX] = endpoint
  context.appendAttributes(append)
}

function onEnter () {
  if (!started) return
  const span = getActiveSpan()
  if (!span) {
    clearContext()
    return
  }
  const context = getOrBuildContext(span)
  // Skip if this CPED already holds the same context. Same allocation-churn
  // fix as the wall profiler in dd-trace-js#8638.
  if (getContext() === context) return
  context.enter()
}

function onSpanFinished (span) {
  if (!started) return
  const cached = span[CachedSym]
  if (cached === undefined) return
  span[CachedSym] = undefined
  const context = cached.context
  if (context === undefined) return
  // The span is over, so its record must stop presenting itself as an active
  // thread context to an out-of-process reader. Invalidating the record covers
  // every async-context frame still holding this same context reference —
  // sibling frames, and continuations the span scheduled before it finished.
  // Detaching only the current frame wouldn't: with enterWith-style activation
  // (sticky storage) no storage:enter fires in those inherited frames to
  // overwrite the record, and in ACF mode there is no `before` hook either, so
  // they would keep exposing the finished span's IDs.
  context.invalidate()
  // Marks the record dead for any pendingEndpoints waiter still holding this
  // entry, which must not append to an invalidated record.
  cached.context = undefined
  // Also detach from the current frame when it is the holder, so the record
  // becomes unreachable and collectable instead of lingering as an invalid one
  // for the rest of the frame's life.
  if (getContext() === context) clearContext()
  // Dropping the cache entry means a later storage:enter naming this same
  // finished span builds a fresh, valid record for it — which is deliberate, and
  // not the staleness invalidate() above exists to prevent. The two cases differ
  // in what the tracer told us: an inherited frame is a frame we never heard
  // about again, while an enter is the tracer affirmatively naming the active
  // span, finished or not. Work running under a finished request span still
  // belongs to that request, so a reader should attribute it there; the wall
  // profiler decides the same way, dropping its per-span context on finish and
  // rebuilding it on re-entry (profiling/profilers/wall.js). Clearing instead
  // would strip trace and endpoint attribution off that work entirely.
}

// The endpoint of a request has settled: fill in every record built while it was
// still unresolved. `span` is the web-server span, so its tag bag is the key its
// descendants enlisted under.
function onEndpointResolved (span) {
  if (!started) return
  const webTags = span.context().getTags()
  const waiting = pendingEndpoints.get(webTags)
  if (waiting === undefined) return
  const endpoint = finalEndpoint(webTags)
  // webTagsCache only announces settled endpoints, so this is belt and braces.
  if (endpoint === undefined) return
  pendingEndpoints.delete(webTags)
  for (const cached of waiting) {
    // A record whose span has since been attributed to a nearer web-server span
    // enlisted again under that bag, and this one is no longer its endpoint.
    if (cached.context !== undefined && cached.webTags === webTags) appendEndpoint(cached.context, endpoint)
  }
}

// webTagsCache has changed which request it attributes this span to: the span
// itself or an ancestor was recognized as a web-server span, giving a record
// built without any web-server ancestry its first endpoint, or a nearer
// web-server span superseded the one this record is showing. Give the record
// the new request's endpoint if it has settled, or wait for its announcement.
function onWebTagsResolved (span) {
  if (!started) return
  const cached = span[CachedSym]
  if (cached === undefined || cached.context === undefined) return
  const webTags = webTagsCache.getCachedWebTags(span)
  if (webTags === cached.webTags) return
  // Recorded so that an announcement for the bag this record was previously
  // waiting on no longer applies to it.
  cached.webTags = webTags
  const endpoint = finalEndpoint(webTags)
  if (endpoint === undefined) {
    // A record that already shows the outer request's endpoint goes on showing
    // it until the nearer one settles: the record buffer is append-only, so
    // there is no way to take the attribute back, and rebuilding the
    // ThreadContext would strand every async-context frame holding this one.
    // The work is still nested in the outer request, which makes that the least
    // wrong of the values available.
    awaitEndpoint(webTags, cached)
  } else {
    appendEndpoint(cached.context, endpoint)
  }
}

// Every otelThreadCtx member the writer calls, checked before it starts. Anything
// missing would otherwise surface from inside a diagnostic-channel subscriber on
// a hot path, where an exception lands in application code: a ThreadContext
// without invalidate() would throw out of onSpanFinished and up through
// DatadogSpan#finish() the first time an activated span finished.
//
// Returns the name of the first missing member, or undefined when the surface is
// complete.
function missingApiMember (ns) {
  if (!ns) return 'otelThreadCtx'
  for (const name of ['ThreadContext', 'getContext', 'clearContext', 'getProcessContextAttributes']) {
    if (typeof ns[name] !== 'function') return name
  }
  for (const name of ['appendAttributes', 'enter', 'invalidate']) {
    if (typeof ns.ThreadContext.prototype[name] !== 'function') return `ThreadContext.prototype.${name}`
  }
}

// Install and detach one throwaway context, to establish that this process can
// actually do it before any span depends on it.
//
// @datadog/pprof decides whether AsyncContextFrame is available by inspecting
// `process.execArgv`, and throws from enter() when it concludes it isn't. That
// disagrees with the feature detection behind `isACFActive` whenever the flag
// reached Node by another route: `NODE_OPTIONS=--experimental-async-context-frame`
// is accepted on Node 22 and 23 and leaves `execArgv` empty, and a worker thread
// created with an explicit `execArgv` loses it too. Since our subscribers run
// inline with `storage.enterWith`, letting that throw would put the exception in
// application code on the first span activation, so find out here instead, where
// declining to start is still an option.
function canInstallContext (ns) {
  try {
    // Zero-filled ids: the record is only readable while it is installed, which
    // is for the length of this function, and an all-zero trace id identifies
    // nothing.
    const probe = new ns.ThreadContext(new Uint8Array(16), new Uint8Array(8))
    probe.enter()
    ns.clearContext()
    return true
  } catch (e) {
    log.warn('OTEP-4947 thread context writer: @datadog/pprof cannot install a thread context', e)
    return false
  }
}

function start () {
  if (started) return true
  if (process.platform !== 'linux') {
    log.debug('OTEP-4947 thread context writer: not on Linux, skipping')
    return false
  }
  if (!isACFActive) {
    log.warn(
      'OTEP-4947 thread context writer requires AsyncContextFrame to be active; not enabling'
    )
    return false
  }
  let pprofMod
  try {
    pprofMod = require('@datadog/pprof')
  } catch (e) {
    log.warn('OTEP-4947 thread context writer: @datadog/pprof unavailable', e)
    return false
  }
  const ns = pprofMod.otelThreadCtx
  const missing = missingApiMember(ns)
  if (missing !== undefined) {
    log.warn(
      'OTEP-4947 thread context writer: installed @datadog/pprof does not expose the otelThreadCtx API (missing %s)',
      missing
    )
    return false
  }
  if (!canInstallContext(ns)) return false
  ThreadContext = ns.ThreadContext
  getContext = ns.getContext
  clearContext = ns.clearContext

  ensureChannelsActivated(isACFActive)
  enterCh.subscribe(onEnter)
  spanFinishCh.subscribe(onSpanFinished)
  // Endpoint updates come from the shared web-tags cache's transition channels
  // rather than from `dd-trace:span:tags:update` directly: the cache already
  // subscribes to that channel and derives both transitions we care about, so
  // this keeps one subscriber on the hot path instead of two, and removes any
  // ordering dependency on the cache having handled an update before we read it.
  webTagsCache.endpointResolvedCh.subscribe(onEndpointResolved)
  webTagsCache.resolvedCh.subscribe(onWebTagsResolved)
  // Turn on the shared web-tags cache's own tagsUpdate subscription for as
  // long as this writer runs — see web-tags-cache.js.
  webTagsCache.activate()

  started = true
  log.info('OTEP-4947 thread context writer started')
  return true
}

// Snapshot of the OTEP-4719 process-context attributes describing this
// writer's on-the-wire record schema — schema-version string, the caller-side
// attribute key map, and the V8 layout constants a reader needs to walk from
// our discovery TLS symbol into the record. Returned in the shape libdatadog's
// napi ThreadLocalMetadata expects:
//
//   { attributeKeys, schemaVersion, extraAttributes: [{ key, intValue|stringValue }] }
//
// Returns undefined unless start() succeeded. Callers should treat that as
// "no threadlocal block" (equivalent to the flag being off) — otherwise we'd
// publish process-context metadata advertising a decodable OTEP-4947 stream
// while no writer is producing records.
function getThreadLocalMetadata () {
  if (!started) return
  // start() verified @datadog/pprof.otelThreadCtx exposes the full API
  // surface (ThreadContext/getContext/clearContext/getProcessContextAttributes),
  // so this require is a cached lookup and the method is guaranteed present.
  const pca = require('@datadog/pprof').otelThreadCtx
    .getProcessContextAttributes(ATTRIBUTE_KEYS)
  const extraAttributes = []
  for (const [key, value] of Object.entries(pca)) {
    if (key === 'threadlocal.schema_version' || key === 'threadlocal.attribute_key_map') continue
    if (typeof value === 'number' && Number.isInteger(value)) {
      extraAttributes.push({ key, intValue: value })
    } else if (typeof value === 'string') {
      extraAttributes.push({ key, stringValue: value })
    } else {
      throw new TypeError(
        `OTEP-4947 process-context attribute ${JSON.stringify(key)} has unsupported value type: ${typeof value}`
      )
    }
  }
  return {
    attributeKeys: [...pca['threadlocal.attribute_key_map']],
    schemaVersion: pca['threadlocal.schema_version'],
    extraAttributes,
  }
}

module.exports = { start, ATTRIBUTE_KEYS, getThreadLocalMetadata }
