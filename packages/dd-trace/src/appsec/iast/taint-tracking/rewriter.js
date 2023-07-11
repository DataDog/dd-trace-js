'use strict'

const Module = require('module')
const shimmer = require('../../../../../datadog-shimmer')
const iastLog = require('../iast-log')
const { isPrivateModule, isNotLibraryFile } = require('./filter')
const { csiMethods } = require('./csi-methods')
const { getName } = require('../telemetry/verbosity')
const { getRewriteFunction } = require('./rewriter-telemetry')

let rewriter
let getPrepareStackTrace
function getRewriter (telemetryVerbosity) {
  if (!rewriter) {
    const iastRewriter = require('@datadog/native-iast-rewriter')
    const Rewriter = iastRewriter.Rewriter
    getPrepareStackTrace = iastRewriter.getPrepareStackTrace
    rewriter = new Rewriter({ csiMethods, telemetryVerbosity: getName(telemetryVerbosity) })
  }
  return rewriter
}

let originalPrepareStackTrace = Error.prepareStackTrace
function getPrepareStackTraceAccessor () {
  let actual = getPrepareStackTrace(originalPrepareStackTrace)
  return {
    configurable: true,
    get () {
      return actual
    },
    set (value) {
      actual = getPrepareStackTrace(value)
      originalPrepareStackTrace = value
    }
  }
}

function getCompileMethodFn (compileMethod) {
  const rewriteFn = getRewriteFunction(rewriter)
  return function (content, filename) {
    try {
      if (isPrivateModule(filename) && isNotLibraryFile(filename)) {
        const rewritten = rewriteFn(content, filename)
        if (rewritten && rewritten.content) {
          return compileMethod.apply(this, [rewritten.content, filename])
        }
      }
    } catch (e) {
      iastLog.error(`Error rewriting ${filename}`)
        .errorAndPublish(e)
    }
    return compileMethod.apply(this, [content, filename])
  }
}

function enableRewriter (telemetryVerbosity) {
  try {
    const rewriter = getRewriter(telemetryVerbosity)
    if (rewriter) {
      const pstDescriptor = Object.getOwnPropertyDescriptor(global.Error, 'prepareStackTrace')
      if (!pstDescriptor || pstDescriptor.configurable) {
        Object.defineProperty(global.Error, 'prepareStackTrace', getPrepareStackTraceAccessor())
      }
      shimmer.wrap(Module.prototype, '_compile', compileMethod => getCompileMethodFn(compileMethod))
    }
  } catch (e) {
    iastLog.error('Error enabling TaintTracking Rewriter')
      .errorAndPublish(e)
  }
}

function disableRewriter () {
  shimmer.unwrap(Module.prototype, '_compile')
  Error.prepareStackTrace = originalPrepareStackTrace
}

module.exports = {
  enableRewriter, disableRewriter
}
