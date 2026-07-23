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

const { HTTP_METHOD, HTTP_ROUTE, RESOURCE_NAME } = require('../../../ext/tags')
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
  endpointNameFromTags,
  getStartedSpans,
} = require('./profiling/webspan-utils')
const webTagsCache = require('./web-tags-cache')

// The endpoint label the writer computes from a web-server span's tag bag
// can change over the span's lifetime: HTTP plugins commonly set
// `http.method` when the request arrives and only add `http.route` (and
// often `resource.name`) once framework routing has resolved the URL.
// OTEP-4947 duplicates are last-wins, so appending a later value would
// correctly overwrite an earlier one — but an out-of-process reader
// sampling the record mid-request would still see the interim value
// (e.g. a bare `GET`) as the endpoint for whatever it was sampling.
// Defer writing the endpoint until the value looks stable — either
// `resource.name` is set, or both `http.method` and `http.route` are —
// and re-check on every subsequent tags update until we can commit.
function isEndpointFinal (tags) {
  return tags != null && (tags[RESOURCE_NAME] != null ||
    (tags[HTTP_METHOD] != null && tags[HTTP_ROUTE] != null))
}

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
//   context:        ThreadContext from @datadog/pprof.otelThreadCtx —
//                   built the first time onEnter activates the span.
//   needsEndpoint:  true when the ThreadContext was built without an
//                   endpoint attribute (the shared web-tags cache came
//                   up empty at build time). Cleared when a late
//                   tagsUpdate lets us append the endpoint.
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
  const webTags = webTagsCache.getCachedWebTags(span)
  // Only publish the endpoint when the value is stable — see isEndpointFinal.
  // Otherwise leave a hole and let onTagsUpdated fill it in when the
  // remaining routing tags arrive.
  const endpointReady = isEndpointFinal(webTags)
  const attrs = []
  attrs[LOCAL_ROOT_SPAN_ID_IDX] = rootContext.toSpanId(true)
  if (endpointReady) attrs[ENDPOINT_IDX] = endpointNameFromTags(webTags)
  attrs[THREAD_NAME_IDX] = THREAD_NAME
  attrs[THREAD_ID_IDX] = THREAD_ID
  if (cached === undefined) {
    cached = {}
    span[CachedSym] = cached
  }
  cached.context = new ThreadContext(traceId, spanId, attrs)
  cached.needsEndpoint = !endpointReady
  return cached.context
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
  // If the writer's record currently belongs to this span, detach it so an
  // out-of-process reader doesn't keep seeing a finished span as the active
  // thread context. The next storage:enter would normally overwrite the
  // record on its own, but with enterWith-style activation (sticky storage)
  // no such fire follows the span finish, leaving stale state.
  if (cached.context !== undefined && getContext() === cached.context) {
    clearContext()
  }
  span[CachedSym] = undefined
}

function onTagsUpdated (span) {
  if (!started) return
  // Subscribed to `dd-trace:span:tags:update` (not to webTagsCache.resolvedCh)
  // because we need to catch content changes — e.g. `http.route` arriving on
  // an already-cached web-server span — not just presence transitions.
  // web-tags-cache subscribes to the same channel at module load and always
  // runs before us (module init happens before start()), so its cache is
  // already up to date when we query it here.
  const cached = span[CachedSym]
  if (cached === undefined || !cached.needsEndpoint || cached.context === undefined) return
  const webTags = webTagsCache.getCachedWebTags(span)
  if (!isEndpointFinal(webTags)) return
  // Append the endpoint in place. The record buffer is shared across every
  // async-context frame holding this context, so the endpoint becomes
  // visible everywhere at once.
  const append = []
  append[ENDPOINT_IDX] = endpointNameFromTags(webTags)
  cached.context.appendAttributes(append)
  cached.needsEndpoint = false
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
      typeof ns.getContext !== 'function' ||
      typeof ns.clearContext !== 'function') {
    log.warn(
      'OTEP-4947 thread context writer: installed @datadog/pprof does not expose the otelThreadCtx API'
    )
    return false
  }
  ThreadContext = ns.ThreadContext
  getContext = ns.getContext
  clearContext = ns.clearContext

  ensureChannelsActivated(isACFActive)
  enterCh.subscribe(onEnter)
  spanFinishCh.subscribe(onSpanFinished)
  tagsUpdateCh.subscribe(onTagsUpdated)

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
// Returns undefined if @datadog/pprof isn't installed or doesn't expose the
// otelThreadCtx.getProcessContextAttributes helper, or if the runtime
// can't actually run the writer (non-Linux, or Linux without
// AsyncContextFrame). Callers should treat that as "no threadlocal
// block" (equivalent to the flag being off) — otherwise we'd publish
// process-context metadata advertising a decodable OTEP-4947 stream
// while no writer is producing records.
function getThreadLocalMetadata () {
  if (process.platform !== 'linux' || !isACFActive) return
  let pprofMod
  try {
    pprofMod = require('@datadog/pprof')
  } catch (e) {
    log.warn('OTEP-4947 thread context: @datadog/pprof unavailable', e)
    return
  }
  const ns = pprofMod.otelThreadCtx
  if (!ns || typeof ns.getProcessContextAttributes !== 'function') {
    log.warn(
      'OTEP-4947 thread context: installed @datadog/pprof does not expose getProcessContextAttributes'
    )
    return
  }
  const pca = ns.getProcessContextAttributes(ATTRIBUTE_KEYS)
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
