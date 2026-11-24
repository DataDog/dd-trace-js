'use strict'

const { isMainThread, threadId } = require('worker_threads')

const END_TIMESTAMP_LABEL = 'end_timestamp_ns'
const THREAD_NAME_LABEL = 'thread name'
const OS_THREAD_ID_LABEL = 'os thread id'
const THREAD_ID_LABEL = 'thread id'
const SPAN_ID_LABEL = 'span id'
const LOCAL_ROOT_SPAN_ID_LABEL = 'local root span id'

// Semantic-convention attributes of OTLP thread labels. thread.id is the managed thread ID: the worker's threadId.
const OTEL_THREAD_NAME = 'thread.name'
const OTEL_THREAD_ID = 'thread.id'
// Labels without a semantic convention are labels of the sample's execution context: sample attributes with this
// prefix, as the eBPF profiler emits them. The backend strips the prefix; it also strips "datadog." from Datadog
// labels and turns their underscores into spaces, so "process.context.label.datadog.os_thread_id" is "os thread id".
const OTEL_CONTEXT_LABEL_PREFIX = 'process.context.label.'
const OTEL_DATADOG_LABEL_PREFIX = `${OTEL_CONTEXT_LABEL_PREFIX}datadog.`
const OTEL_OS_THREAD_ID = `${OTEL_DATADOG_LABEL_PREFIX}os_thread_id`

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
  threadNamePrefix,
  eventLoopThreadName,
  getNonJSThreadsLabels,
  getNonJSThreadsOtelLabels,
  getThreadLabels: cacheThreadLabels(),
  getOtelThreadLabels: cacheOtelThreadLabels(),
  encodeProfileAsync,
}
