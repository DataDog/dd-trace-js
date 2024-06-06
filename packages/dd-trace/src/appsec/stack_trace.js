'use strict'

const { calculateDDBasePath } = require('../util')

const ddBasePath = calculateDDBasePath(__dirname)

const MAX_STACK_TRACE_DEPTH = 100 // Hard limit

function getCallSiteList () {
  const previousPrepareStackTrace = Error.prepareStackTrace
  const previousStackTraceLimit = Error.stackTraceLimit
  let callsiteList
  Error.stackTraceLimit = MAX_STACK_TRACE_DEPTH
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

function cutDownFrames (callSiteList, maxDepth) {
  const maxCallSite = maxDepth < 1 ? MAX_STACK_TRACE_DEPTH : Math.min(maxDepth, MAX_STACK_TRACE_DEPTH)
  if (callSiteList.length > maxCallSite) {
    const half = Math.round(maxCallSite / 2)
    return callSiteList.slice(0, half).concat(callSiteList.slice(-(maxCallSite - half)))
  }

  return callSiteList
}

function getFramesForMetaStruct (callSiteList, maxDepth = 32) {
  const filteredFrames = filterOutFramesFromLibrary(callSiteList)
  const indexedFrames = filteredFrames.map((callSite, i) => {
    return {
      id: i++,
      file: callSite.getFileName(),
      line: callSite.getLineNumber(),
      column: callSite.getColumnNumber(),
      function: callSite.getFunctionName()
    }
  })
  return cutDownFrames(indexedFrames, maxDepth)
}

function reportStackTrace (rootSpan, stackId, maxDepth, maxStackTraces, callSiteListGetter = getCallSiteList) {
  if (!rootSpan) return

  let metaStruct = rootSpan.meta_struct
  if (!metaStruct) {
    metaStruct = {}
    rootSpan.meta_struct = metaStruct
  }
  let ddStack = metaStruct['_dd.stack']
  if (!ddStack) {
    metaStruct['_dd.stack'] = ddStack = {}
  }
  let exploitStacks = ddStack.exploit
  if (!exploitStacks) {
    exploitStacks = []
    ddStack.exploit = exploitStacks
  }
  if (exploitStacks.length < maxStackTraces) {
    const callSiteList = callSiteListGetter()
    const frames = getFramesForMetaStruct(callSiteList, maxDepth)
    exploitStacks.push({
      id: stackId,
      language: 'nodejs',
      frames
    })
  }
}

module.exports = {
  getCallSiteList,
  filterOutFramesFromLibrary,
  cutDownFrames,
  reportStackTrace
}
