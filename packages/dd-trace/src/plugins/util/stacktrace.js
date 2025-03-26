'use strict'

const { relative, sep, isAbsolute } = require('path')

const cwd = process.cwd()

module.exports = {
  getCallSites,
  getUserLandFrames
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

/**
 * Get stack trace of user-land frames.
 *
 * @param {Function} constructorOpt - Function to pass along to Error.captureStackTrace
 * @param {number} [limit=Infinity] - The maximum number of frames to return
 * @returns {{ file: string, line: number, method: (string|undefined), type: (string|undefined) }[]} - A
 */
function getUserLandFrames (constructorOpt, limit = Infinity) {
  const callsites = getCallSites(constructorOpt)
  const frames = []

  for (const callsite of callsites) {
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

    const method = callsite.getFunctionName()
    const type = callsite.getTypeName()
    frames.push({
      file: filename,
      line: callsite.getLineNumber(),
      column: callsite.getColumnNumber(),
      method: method ?? undefined, // force to undefined if null so JSON.stringify will omit it
      type: type ?? undefined // force to undefined if null so JSON.stringify will omit it
    })

    if (frames.length === limit) break
  }

  return frames
}
