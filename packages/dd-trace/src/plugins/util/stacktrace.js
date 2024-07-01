'use strict'

const { relative } = require('path')

const cwd = process.cwd()

module.exports = {
  getCallSites,
  getUserLandCallsites,
  getTopUserLandCallsite,
  getRelativeFilename,
  getSpanOriginTags
}

// From https://github.com/felixge/node-stack-trace/blob/ba06dcdb50d465cd440d84a563836e293b360427/index.js#L1
function getCallSites (constructorOpt) {
  const oldLimit = Error.stackTraceLimit
  Error.stackTraceLimit = Infinity

  const dummy = {}

  const v8Handler = Error.prepareStackTrace
  Error.prepareStackTrace = function (_, v8StackTrace) {
    return v8StackTrace
  }
  Error.captureStackTrace(dummy, constructorOpt)

  const v8StackTrace = dummy.stack
  Error.prepareStackTrace = v8Handler
  Error.stackTraceLimit = oldLimit

  return v8StackTrace
}

function getUserLandCallsites (constructorOpt = getUserLandCallsites) {
  const callsites = getCallSites(constructorOpt)
  for (let i = 0; i < callsites.length; i++) {
    const fullPath = callsites[i].getFileName()

    if (fullPath === null) {
      continue
    }
    // TODO: Now sure why some paths start with this
    const containsFileProtocol = fullPath.startsWith('file://')
    if (fullPath.startsWith(cwd, containsFileProtocol ? 7 : 0) === false) {
      continue
    }
    const relativePath = getRelativeFilename(fullPath, containsFileProtocol)
    if (relativePath.startsWith('node_modules/') || relativePath.includes('/node_modules/')) {
      continue
    }

    return i === 0 ? callsites : callsites.slice(i)
  }
}

function getTopUserLandCallsite (constructorOpt) {
  const callsites = getUserLandCallsites(constructorOpt)
  return callsites && callsites[0]
}

// TODO: Now sure why some paths start with this
function getRelativeFilename (filename, containsFileProtocol) {
  if (containsFileProtocol === undefined) {
    containsFileProtocol = filename.startsWith('file://')
  }
  return relative(containsFileProtocol ? 'file://' + cwd : cwd, filename)
}

// TODO: This should be somewhere else specifically related to Span Origin
function getSpanOriginTags (callsite) {
  if (!callsite) return
  const file = getRelativeFilename(callsite.getFileName())
  const line = callsite.getLineNumber()
  const method = callsite.getFunctionName()
  return method
    ? {
        '_dd.entry_location.file': file,
        '_dd.entry_location.line': line,
        '_dd.entry_location.method': method
      }
    : {
        '_dd.entry_location.file': file,
        '_dd.entry_location.line': line
      }
}
