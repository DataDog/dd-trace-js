'use strict'

const { relative, sep, isAbsolute } = require('path')

const cwd = process.cwd()

module.exports = {
  getCallSites,
  getUserLandCallsites,
  getTopUserLandCallsite,
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

function getUserLandCallsites (constructorOpt = getUserLandCallsites, returnTopUserLandFrameOnly = false) {
  const callsites = getCallSites(constructorOpt)
  for (let i = 0; i < callsites.length; i++) {
    const callsite = callsites[i]

    if (callsite.isNative()) {
      continue
    }

    const filename = callsite.getFileName()

    // If the callsite is native, there will be no associated filename. However, there might be other instances where
    // this can happen, so to be sure, we add this additional check
    if (filename === null) {
      continue
    }

    // ESM module paths start with the "file://" protocol (because ESM supports https imports)
    // TODO: Node.js also supports `data:` and `node:` imports, should we do something specific for `data:`?
    const containsFileProtocol = filename.startsWith('file:')

    // TODO: I'm not sure how stable this check is. Alternatively, we could consider reversing it if we can get
    // a comprehensive list of all non-file-based values, eg:
    //
    //     filename === '<anonymous>' || filename.startsWith('node:')
    if (containsFileProtocol === false && isAbsolute(filename) === false) {
      continue
    }

    // TODO: Technically, the algorithm below could be simplified to not use the relative path, but be simply:
    //
    //     if (filename.includes(sep + 'node_modules' + sep)) continue
    //
    // However, the tests in `packages/dd-trace/test/plugins/util/stacktrace.spec.js` will fail on my machine
    // because I have the source code in a parent folder called `node_modules`. So the code below thinks that
    // it's not in user-land
    const relativePath = relative(cwd, containsFileProtocol ? filename.substring(7) : filename)
    if (relativePath.startsWith('node_modules' + sep) || relativePath.includes(sep + 'node_modules' + sep)) {
      continue
    }

    return returnTopUserLandFrameOnly
      ? callsite
      : (i === 0 ? callsites : callsites.slice(i))
  }
}

function getTopUserLandCallsite (constructorOpt) {
  return getUserLandCallsites(constructorOpt, true)
}

// TODO: This should be somewhere else specifically related to Span Origin
function getSpanOriginTags (callsite) {
  if (!callsite) return
  const file = callsite.getFileName()
  const line = String(callsite.getLineNumber())
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
