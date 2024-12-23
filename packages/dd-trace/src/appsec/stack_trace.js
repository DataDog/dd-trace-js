'use strict'

const { calculateDDBasePath } = require('../util')

const ddBasePath = calculateDDBasePath(__dirname)

const LIBRARY_FRAMES_BUFFER = 20

const STACK_TRACE_NAMESPACES = {
  RASP: 'exploit',
  IAST: 'vulnerability'
}

function getCallSiteList (maxDepth = 100) {
  if (maxDepth < 1) maxDepth = Infinity

  const previousPrepareStackTrace = Error.prepareStackTrace
  const previousStackTraceLimit = Error.stackTraceLimit
  let callsiteList
  // Since some frames will be discarded because they come from tracer codebase, a buffer is added
  // to the limit in order to get as close as `maxDepth` number of frames.
  Error.stackTraceLimit = maxDepth + LIBRARY_FRAMES_BUFFER

  try {
    Error.prepareStackTrace = function (_, callsites) {
      callsiteList = callsites
    }
    const e = new Error()
    e.stack
  } finally {
    Error.prepareStackTrace = previousPrepareStackTrace
    Error.stackTraceLimit = previousStackTraceLimit
  }

  return callsiteList
}

function filterOutFramesFromLibrary (callSiteList) {
  return callSiteList.filter(callSite => !callSite.getFileName()?.startsWith(ddBasePath))
}

function getFramesForMetaStruct (callSiteList, maxDepth = 32) {
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
      class_name: callSite.getTypeName()
    })
  }

  return indexedFrames
}

function reportStackTrace (
  rootSpan, stackId, maxDepth, maxStackTraces, callSiteList, namespace = STACK_TRACE_NAMESPACES.RASP) {
  if (!rootSpan) return

  if (maxStackTraces < 1 || (rootSpan.meta_struct?.['_dd.stack']?.[namespace]?.length ?? 0) < maxStackTraces) {
    if (maxDepth < 1) maxDepth = Infinity
    if (!Array.isArray(callSiteList)) return

    if (!rootSpan.meta_struct) {
      rootSpan.meta_struct = {}
    }

    if (!rootSpan.meta_struct['_dd.stack']) {
      rootSpan.meta_struct['_dd.stack'] = {}
    }

    if (!rootSpan.meta_struct['_dd.stack'][namespace]) {
      rootSpan.meta_struct['_dd.stack'][namespace] = []
    }

    const frames = getFramesForMetaStruct(callSiteList, maxDepth)

    rootSpan.meta_struct['_dd.stack'][namespace].push({
      id: stackId,
      language: 'nodejs',
      frames
    })
  }
}

module.exports = {
  getCallSiteList,
  reportStackTrace,
  STACK_TRACE_NAMESPACES
}
