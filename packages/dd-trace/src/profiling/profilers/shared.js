'use strict'

const { isMainThread, threadId } = require('worker_threads')

const END_TIMESTAMP_LABEL = 'end_timestamp_ns'
const THREAD_NAME_LABEL = 'thread name'
const OS_THREAD_ID_LABEL = 'os thread id'
const THREAD_ID_LABEL = 'thread id'
const SPAN_ID_LABEL = 'span id'
const LOCAL_ROOT_SPAN_ID_LABEL = 'local root span id'
// Carries a span's 128-bit trace ID in OTLP sample labels, until createOtelLinkExtractor() turns it and the span ID
// into the sample's link
const TRACE_ID_LABEL = 'trace id'

// Semantic-convention attributes of OTLP thread labels. thread.id is the managed thread ID: the worker's threadId.
const OTEL_THREAD_NAME = 'thread.name'
const OTEL_THREAD_ID = 'thread.id'
// Labels without a semantic convention are labels of the sample's execution context: sample attributes with this
// prefix, as the eBPF profiler emits them. The backend strips the prefix; it also strips "datadog." from Datadog
// labels and turns their underscores into spaces, so "process.context.label.datadog.os_thread_id" is "os thread id".
const OTEL_CONTEXT_LABEL_PREFIX = 'process.context.label.'
const OTEL_DATADOG_LABEL_PREFIX = `${OTEL_CONTEXT_LABEL_PREFIX}datadog.`
const OTEL_OS_THREAD_ID = `${OTEL_DATADOG_LABEL_PREFIX}os_thread_id`
const OTEL_LOCAL_ROOT_SPAN_ID = `${OTEL_DATADOG_LABEL_PREFIX}local_root_span_id`
const OTEL_TRACE_ENDPOINT = `${OTEL_DATADOG_LABEL_PREFIX}trace_endpoint`
const OTEL_ASYNC_ID = `${OTEL_DATADOG_LABEL_PREFIX}async_id`

const threadNamePrefix = isMainThread ? 'Main' : `Worker #${threadId}`
const eventLoopThreadName = `${threadNamePrefix} Event Loop`

function getThreadLabels () {
  const pprof = require('@datadog/pprof')
  const nativeThreadId = pprof.getNativeThreadId()
  return {
    [THREAD_NAME_LABEL]: eventLoopThreadName,
    [THREAD_ID_LABEL]: threadId.toString(),
    [OS_THREAD_ID_LABEL]: nativeThreadId.toString(),
  }
}

function cacheThreadLabels () {
  let labels
  return () => {
    if (!labels) {
      labels = getThreadLabels()
    }
    return labels
  }
}

function cacheOtelThreadLabels () {
  let labels
  return () => {
    labels ??= {
      [OTEL_THREAD_NAME]: eventLoopThreadName,
      [OTEL_THREAD_ID]: threadId,
      [OTEL_OS_THREAD_ID]: require('@datadog/pprof').getNativeThreadId().toString(),
    }
    return labels
  }
}

const nonJSThreadsOtelLabels = { [OTEL_THREAD_NAME]: 'Non-JS threads' }

function getNonJSThreadsOtelLabels () {
  return nonJSThreadsOtelLabels
}

// The OTLP labels of custom labels objects, which the samples taken in a runWithLabels() call share
const otelCustomLabels = new WeakMap()

/**
 * Returns the custom labels of a sample as OTLP sample labels: execution context labels under their own keys.
 *
 * @param {Record<string, string | number>} customLabels
 * @returns {Record<string, string | number>}
 */
function getOtelCustomLabels (customLabels) {
  let labels = otelCustomLabels.get(customLabels)
  if (labels === undefined) {
    labels = {}
    for (const [key, value] of Object.entries(customLabels)) {
      labels[`${OTEL_CONTEXT_LABEL_PREFIX}${key}`] = value
    }
    otelCustomLabels.set(customLabels, labels)
  }
  return labels
}

/**
 * Returns a link extractor for an OTLP profiles builder: it turns a sample's span ID and trace ID labels into the
 * sample's link, and removes them from the labels. Links are cached, as the samples of a span share one.
 */
function createOtelLinkExtractor () {
  const links = new Map()
  /** @param {Array<[string, string | number | bigint]>} labels */
  return labels => {
    let spanId
    let traceId
    const otherLabels = []
    for (const label of labels) {
      if (label[0] === SPAN_ID_LABEL) {
        spanId = label[1]
      } else if (label[0] === TRACE_ID_LABEL) {
        traceId = label[1]
      } else {
        otherLabels.push(label)
      }
    }
    if (typeof spanId !== 'bigint' || typeof traceId !== 'bigint') {
      return { labels: otherLabels }
    }
    // A span ID tells the span, and so its trace, apart, so it's the key on its own
    let link = links.get(spanId)
    if (link === undefined) {
      const traceIdBytes = Buffer.alloc(16)
      traceIdBytes.writeBigUInt64BE(BigInt.asUintN(64, traceId >> 64n), 0)
      traceIdBytes.writeBigUInt64BE(BigInt.asUintN(64, traceId), 8)
      const spanIdBytes = Buffer.alloc(8)
      spanIdBytes.writeBigUInt64BE(BigInt.asUintN(64, spanId))
      link = { traceId: traceIdBytes, spanId: spanIdBytes }
      links.set(spanId, link)
    }
    return { link, labels: otherLabels }
  }
}

function getNonJSThreadsLabels () {
  return { [THREAD_NAME_LABEL]: 'Non-JS threads', [THREAD_ID_LABEL]: 'NA', [OS_THREAD_ID_LABEL]: 'NA' }
}

function encodeProfileAsync (profile) {
  return profile.encodeAsync().then(Buffer.from)
}

module.exports = {
  END_TIMESTAMP_LABEL,
  THREAD_NAME_LABEL,
  THREAD_ID_LABEL,
  OS_THREAD_ID_LABEL,
  SPAN_ID_LABEL,
  LOCAL_ROOT_SPAN_ID_LABEL,
  TRACE_ID_LABEL,
  OTEL_LOCAL_ROOT_SPAN_ID,
  OTEL_TRACE_ENDPOINT,
  OTEL_ASYNC_ID,
  threadNamePrefix,
  eventLoopThreadName,
  getNonJSThreadsLabels,
  getNonJSThreadsOtelLabels,
  getThreadLabels: cacheThreadLabels(),
  getOtelThreadLabels: cacheOtelThreadLabels(),
  getOtelCustomLabels,
  createOtelLinkExtractor,
  encodeProfileAsync,
}
