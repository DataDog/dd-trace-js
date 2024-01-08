'use strict'

const { isMainThread, threadId } = require('worker_threads')

const END_TIMESTAMP_LABEL = 'end_timestamp_ns'
const THREAD_NAME_LABEL = 'thread name'
const OS_THREAD_ID_LABEL = 'os thread id'
const THREAD_ID_LABEL = 'thread id'
const threadNamePrefix = isMainThread ? 'Main' : `Worker #${threadId}`
const eventLoopThreadName = `${threadNamePrefix} Event Loop`

function getThreadLabels () {
  const pprof = require('@datadog/pprof')
  const nativeThreadId = pprof.getNativeThreadId()
  return {
    [THREAD_NAME_LABEL]: eventLoopThreadName,
    [THREAD_ID_LABEL]: `${threadId}`,
    [OS_THREAD_ID_LABEL]: `${nativeThreadId}`
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

function getNonJSThreadsLabels () {
  return { [THREAD_NAME_LABEL]: 'Non-JS threads', [THREAD_ID_LABEL]: 'NA', [OS_THREAD_ID_LABEL]: 'NA' }
}

module.exports = {
  END_TIMESTAMP_LABEL,
  THREAD_NAME_LABEL,
  THREAD_ID_LABEL,
  OS_THREAD_ID_LABEL,
  threadNamePrefix,
  eventLoopThreadName,
  getNonJSThreadsLabels,
  getThreadLabels: cacheThreadLabels()
}
