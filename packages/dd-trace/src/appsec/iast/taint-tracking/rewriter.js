'use strict'

const Module = require('module')
const shimmer = require('../../../../../datadog-shimmer')
const iastLog = require('../iast-log')
const { isPrivateModule, isNotLibraryFile } = require('./filter')
const { csiMethods } = require('./csi-methods')
const { getName } = require('../telemetry/verbosity')
const { getRewriteFunction } = require('./rewriter-telemetry')
const dc = require('dc-polyfill')

const hardcodedSecretCh = dc.channel('datadog:secrets:result')
const sourcePreloadChannel = dc.channel('datadog:esm:source:preload')

let rewriter
let getPrepareStackTrace

let getRewriterOriginalPathAndLineFromSourceMap = function (path, line, column) {
  return { path, line, column }
}

function isFlagPresent (flag) {
  return process.env.NODE_OPTIONS?.includes(flag) ||
    process.execArgv?.some(arg => arg.includes(flag))
}

function getGetOriginalPathAndLineFromSourceMapFunction (chainSourceMap, getOriginalPathAndLineFromSourceMap) {
  if (chainSourceMap) {
    return function (path, line, column) {
      // if --enable-source-maps is present stacktraces of the rewritten files contain the original path, file and
      // column because the sourcemap chaining is done during the rewriting process so we can skip it
      if (isPrivateModule(path) && isNotLibraryFile(path)) {
        return { path, line, column }
      } else {
        return getOriginalPathAndLineFromSourceMap(path, line, column)
      }
    }
  } else {
    return getOriginalPathAndLineFromSourceMap
  }
}

function getRewriter (telemetryVerbosity) {
  if (!rewriter) {
    try {
      const iastRewriter = require('@datadog/native-iast-rewriter')
      const Rewriter = iastRewriter.Rewriter
      getPrepareStackTrace = iastRewriter.getPrepareStackTrace

      const chainSourceMap = isFlagPresent('--enable-source-maps')
      const getOriginalPathAndLineFromSourceMap = iastRewriter.getOriginalPathAndLineFromSourceMap
      if (getOriginalPathAndLineFromSourceMap) {
        getRewriterOriginalPathAndLineFromSourceMap =
          getGetOriginalPathAndLineFromSourceMapFunction(chainSourceMap, getOriginalPathAndLineFromSourceMap)
      }

      rewriter = new Rewriter({
        csiMethods,
        telemetryVerbosity: getName(telemetryVerbosity),
        chainSourceMap
      })
    } catch (e) {
      iastLog.error('Unable to initialize TaintTracking Rewriter')
        .errorAndPublish(e)
    }
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
  return function (content, filename) {
    try {
      const rewritten = rewriteContent(content, filename)

      if (rewritten?.content) {
        return compileMethod.apply(this, [rewritten.content, filename])
      }
    } catch (e) {
      iastLog.error(`Error rewriting ${filename}`)
        .errorAndPublish(e)
    }
    return compileMethod.apply(this, [content, filename])
  }
}

function rewriteContent (content, filename) {
  const rewriteFn = getRewriteFunction(rewriter)

  if (isPrivateModule(filename) && isNotLibraryFile(filename)) {
    if (typeof content !== 'string') {
      content = content.toString()
    }
    const rewritten = rewriteFn(content, filename)

    if (rewritten?.literalsResult && hardcodedSecretCh.hasSubscribers) {
      hardcodedSecretCh.publish(rewritten.literalsResult)
    }
    return rewritten
  }
  return undefined
}

function rewriteESMModule (data) {
  const rewritten = rewriteContent(Buffer.from(data.source), data.url)
  if (rewritten) {
    data.source = Buffer.from(rewritten.content)
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
      sourcePreloadChannel.subscribe(rewriteESMModule)
    }
  } catch (e) {
    iastLog.error('Error enabling TaintTracking Rewriter')
      .errorAndPublish(e)
  }
}

function disableRewriter () {
  shimmer.unwrap(Module.prototype, '_compile')
  sourcePreloadChannel.unsubscribe(rewriteESMModule)
  Error.prepareStackTrace = originalPrepareStackTrace
}

function getOriginalPathAndLineFromSourceMap ({ path, line, column }) {
  return getRewriterOriginalPathAndLineFromSourceMap(path, line, column)
}

module.exports = {
  enableRewriter, disableRewriter, getOriginalPathAndLineFromSourceMap
}
