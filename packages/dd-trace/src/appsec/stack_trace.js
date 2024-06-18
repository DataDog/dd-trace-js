'use strict'

const { calculateDDBasePath } = require('../util')

const ddBasePath = calculateDDBasePath(__dirname)

const LIBRARY_FRAMES_BUFFER = 20

function getCallSiteList (maxDepth = 100) {
  const previousPrepareStackTrace = Error.prepareStackTrace
  const previousStackTraceLimit = Error.stackTraceLimit
  let callsiteList
  Error.stackTraceLimit = maxDepth

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
  return callSiteList.filter(callSite => !callSite.getFileName().includes(ddBasePath))
}

function getFramesForMetaStruct (callSiteList, maxDepth = 32) {
  const maxCallSite = maxDepth < 1 ? Infinity : maxDepth

  const filteredFrames = filterOutFramesFromLibrary(callSiteList)

  const half = filteredFrames.length > maxCallSite ? Math.round(maxCallSite / 2) : Infinity

  const indexedFrames = []
  for (let i = 0; i < Math.min(filteredFrames.length, maxCallSite); i++) {
    const index = i < half ? i : i + filteredFrames.length - maxCallSite
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

function reportStackTrace (rootSpan, stackId, maxDepth, maxStackTraces, callSiteListGetter = getCallSiteList) {
  if (!rootSpan) return

  if (!rootSpan.meta_struct) {
    rootSpan.meta_struct = {}
  }

  if (!rootSpan.meta_struct['_dd.stack']) {
    rootSpan.meta_struct['_dd.stack'] = {}
  }

  if (!rootSpan.meta_struct['_dd.stack'].exploit) {
    rootSpan.meta_struct['_dd.stack'].exploit = []
  }

  if (maxStackTraces < 1 || rootSpan.meta_struct['_dd.stack'].exploit.length < maxStackTraces) {
    // Since some frames will be discarded because they come from tracer codebase, a buffer is added
    // to the limit in order to get as close as `maxDepth` number of frames.
    const stackTraceLimit = maxDepth < 1 ? Infinity : maxDepth + LIBRARY_FRAMES_BUFFER
    const callSiteList = callSiteListGetter(stackTraceLimit)
    const frames = getFramesForMetaStruct(callSiteList, maxDepth)

    rootSpan.meta_struct['_dd.stack'].exploit.push({
      id: stackId,
      language: 'nodejs',
      frames
    })
  }
}

module.exports = {
  getCallSiteList,
  filterOutFramesFromLibrary,
  reportStackTrace
}
