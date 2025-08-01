'use strict'

const { ddBasePath } = require('../util')

const LIBRARY_FRAMES_BUFFER = 20

const STACK_TRACE_NAMESPACES = {
  RASP: 'exploit',
  IAST: 'vulnerability'
}

function prepareStackTrace (_, callsites) {
  return callsites
}

function getCallSiteList (maxDepth = 100, constructorOpt) {
  const previousPrepareStackTrace = Error.prepareStackTrace
  const previousStackTraceLimit = Error.stackTraceLimit
  // Since some frames will be discarded because they come from tracer codebase, a buffer is added
  // to the limit in order to get as close as `maxDepth` number of frames.
  Error.stackTraceLimit = maxDepth + LIBRARY_FRAMES_BUFFER

  try {
    Error.prepareStackTrace = prepareStackTrace
    const obj = {}
    Error.captureStackTrace(obj, constructorOpt)
    return obj.stack
  } finally {
    Error.prepareStackTrace = previousPrepareStackTrace
    Error.stackTraceLimit = previousStackTraceLimit
  }
}

function filterOutFramesFromLibrary (callSiteList) {
  return callSiteList.filter(callSite => !callSite.getFileName()?.startsWith(ddBasePath))
}

function getCallsiteFrames (maxDepth = 32, constructorOpt = getCallsiteFrames, callSiteListGetter = getCallSiteList) {
  if (maxDepth < 1) maxDepth = Infinity

  const callSiteList = callSiteListGetter(maxDepth, constructorOpt)
  const filteredFrames = filterOutFramesFromLibrary(callSiteList)

  const half = filteredFrames.length > maxDepth ? Math.round(maxDepth / 2) : Infinity

  const indexedFrames = []
  for (let i = 0; i < Math.min(filteredFrames.length, maxDepth); i++) {
    const index = i < half ? i : i + filteredFrames.length - maxDepth
    const callSite = filteredFrames[index]
    indexedFrames.push({
      id: index,
      file: callSite.getFileName(),
      line: callSite.getLineNumber(),
      column: callSite.getColumnNumber(),
      function: callSite.getFunctionName(),
      class_name: callSite.getTypeName(),
      isNative: callSite.isNative()
    })
  }

  return indexedFrames
}

function reportStackTrace (rootSpan, stackId, frames, namespace = STACK_TRACE_NAMESPACES.RASP) {
  if (!rootSpan) return
  if (!Array.isArray(frames)) return

  if (!rootSpan.meta_struct) {
    rootSpan.meta_struct = {}
  }

  if (!rootSpan.meta_struct['_dd.stack']) {
    rootSpan.meta_struct['_dd.stack'] = {}
  }

  if (!rootSpan.meta_struct['_dd.stack'][namespace]) {
    rootSpan.meta_struct['_dd.stack'][namespace] = []
  }

  rootSpan.meta_struct['_dd.stack'][namespace].push({
    id: stackId,
    language: 'nodejs',
    frames
  })
}

function canReportStackTrace (rootSpan, maxStackTraces, namespace = STACK_TRACE_NAMESPACES.RASP) {
  if (!rootSpan) return false

  return maxStackTraces < 1 || (rootSpan.meta_struct?.['_dd.stack']?.[namespace]?.length ?? 0) < maxStackTraces
}

module.exports = {
  getCallsiteFrames,
  reportStackTrace,
  canReportStackTrace,
  STACK_TRACE_NAMESPACES
}
