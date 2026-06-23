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
  tagsUpdateCh,
  getActiveSpan,
  ensureChannelsActivated,
} = require('./storage-channels')
const {
  isWebServerSpan,
  endpointNameFromTags,
  getStartedSpans,
} = require('./profiling/webspan-utils')

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
// Fields populated lazily:
//   context: ThreadContext from @datadog/pprof.otelThreadCtx — built the first
//     time onEnter activates the span.
//   webTagsResolved + webTags: true once the parent-chain walk has
//     run; webTags is the resolved tag bag (or undefined when no web
//     ancestor was found).
const CachedSym = Symbol('OtelThreadCtx.cached')

let started = false
let ThreadContext
let setContext
let getContext

function getOrCreateCache (span) {
  let cached = span[CachedSym]
  if (cached === undefined) {
    cached = {}
    span[CachedSym] = cached
  }
  return cached
}

// Walks up the started-spans stack to find the nearest ancestor whose
// tags identify it as a web-server span. Mirrors the same walk in
// profiling/profilers/wall.js (which keeps its own cache under a
// different Symbol). If the two ever drift we should extract.
function getCachedWebTags (span) {
  const cached = getOrCreateCache(span)
  if (cached.webTagsResolved) return cached.webTags
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
  cached.webTagsResolved = true
  return webTags
}

function getOrBuildContext (span) {
  const cached = getOrCreateCache(span)
  if (cached.context !== undefined) return cached.context
  const spanContext = span.context()
  const traceId = Uint8Array.from(Buffer.from(spanContext.toTraceId(true), 'hex'))
  const spanId = Uint8Array.from(Buffer.from(spanContext.toSpanId(true), 'hex'))
  // Local root span: the first entry in the trace's started-spans list, or
  // this span itself when it IS the root. Encoded as 16-char lowercase hex
  // per the libdatadog convention.
  const startedSpans = getStartedSpans(spanContext)
  const rootContext = startedSpans.length ? startedSpans[0].context() : spanContext
  const webTags = getCachedWebTags(span)
  const attrs = []
  attrs[LOCAL_ROOT_SPAN_ID_IDX] = rootContext.toSpanId(true)
  if (webTags) attrs[ENDPOINT_IDX] = endpointNameFromTags(webTags)
  attrs[THREAD_NAME_IDX] = THREAD_NAME
  attrs[THREAD_ID_IDX] = THREAD_ID
  cached.context = new ThreadContext(traceId, spanId, attrs)
  return cached.context
}

function onEnter () {
  if (!started) return
  const span = getActiveSpan()
  if (!span) {
    setContext(undefined)
    return
  }
  const context = getOrBuildContext(span)
  // Skip if this CPED already holds the same context. Same allocation-churn
  // fix as the wall profiler in dd-trace-js#8638.
  if (getContext() === context) return
  setContext(context)
}

function onSpanFinished (span) {
  if (!started) return
  const cached = span[CachedSym]
  if (cached === undefined) return
  // If the writer's record currently belongs to this span, detach it so an
  // out-of-process reader doesn't keep seeing a finished span as the active
  // thread context. The next storage:enter would normally overwrite the
  // record on its own, but with enterWith-style activation (sticky storage)
  // no such fire follows the span finish, leaving stale state.
  if (cached.context !== undefined && getContext() === cached.context) {
    setContext(undefined)
  }
  span[CachedSym] = undefined
}

function onTagsUpdated (span) {
  if (!started) return
  const cached = span[CachedSym]
  // Skip unless the prior parent-chain walk already ran and came up
  // empty. If the walk hasn't happened yet (cached.webTagsResolved
  // false), onEnter will resolve it the natural way. If it ran and
  // found a web span, we already have the endpoint.
  if (cached === undefined || !cached.webTagsResolved || cached.webTags !== undefined) return
  const tags = span.context().getTags()
  if (!isWebServerSpan(tags)) return
  cached.webTags = tags
  if (cached.context !== undefined) {
    // The context was already built without an endpoint; append it in
    // place. The record buffer is shared across every async-context
    // frame holding this context, so the endpoint becomes visible
    // everywhere at once.
    const append = []
    append[ENDPOINT_IDX] = endpointNameFromTags(tags)
    cached.context.appendAttributes(append)
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
  if (!ns || typeof ns.ThreadContext !== 'function' ||
      typeof ns.setContext !== 'function' ||
      typeof ns.getContext !== 'function') {
    log.warn(
      'OTEP-4947 thread context writer: installed @datadog/pprof does not expose the otelThreadCtx API'
    )
    return false
  }
  ThreadContext = ns.ThreadContext
  setContext = ns.setContext
  getContext = ns.getContext

  ensureChannelsActivated(isACFActive)
  enterCh.subscribe(onEnter)
  spanFinishCh.subscribe(onSpanFinished)
  tagsUpdateCh.subscribe(onTagsUpdated)

  started = true
  log.info('OTEP-4947 thread context writer started')
  return true
}

module.exports = { start, ATTRIBUTE_KEYS }
