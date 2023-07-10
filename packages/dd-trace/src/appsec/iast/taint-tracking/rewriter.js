'use strict'

const Module = require('module')
const shimmer = require('../../../../../datadog-shimmer')
const iastLog = require('../iast-log')
const { isPrivateModule, isNotLibraryFile } = require('./filter')
const { csiMethods } = require('./csi-methods')

let rewriter
let getPrepareStackTrace
let getRewriterOriginalPathAndLineFromSourceMap = function (path, line, column) {
  return { path, line, column }
}

function isEnableSourceMapsFlagPresent () {
  return process.execArgv &&
    process.execArgv.some(arg => arg.includes('--enable-source-maps'))
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

function getRewriter () {
  if (!rewriter) {
    try {
      const iastRewriter = require('@datadog/native-iast-rewriter')
      const Rewriter = iastRewriter.Rewriter
      getPrepareStackTrace = iastRewriter.getPrepareStackTrace

      const chainSourceMap = isEnableSourceMapsFlagPresent()
      getRewriterOriginalPathAndLineFromSourceMap =
        getGetOriginalPathAndLineFromSourceMapFunction(chainSourceMap, iastRewriter.getOriginalPathAndLineFromSourceMap)
      rewriter = new Rewriter({ csiMethods, chainSourceMap, logLevel: "DEBUG", logger: {"error": console.log, log: console.log, debug: console.log}})
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
      if (isPrivateModule(filename) && isNotLibraryFile(filename)) {
        const rewritten = rewriter.rewrite(content, filename)
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

function enableRewriter () {
  const rewriter = getRewriter()
  if (rewriter) {
    const pstDescriptor = Object.getOwnPropertyDescriptor(global.Error, 'prepareStackTrace')
    if (!pstDescriptor || pstDescriptor.configurable) {
      Object.defineProperty(global.Error, 'prepareStackTrace', getPrepareStackTraceAccessor())
    }
    shimmer.wrap(Module.prototype, '_compile', compileMethod => getCompileMethodFn(compileMethod))
  }
}

function disableRewriter () {
  shimmer.unwrap(Module.prototype, '_compile')
  Error.prepareStackTrace = originalPrepareStackTrace
}

function getOriginalPathAndLineFromSourceMap ({ path, line, column }) {
  return getRewriterOriginalPathAndLineFromSourceMap(path, line, column)
}

module.exports = {
  enableRewriter, disableRewriter, getOriginalPathAndLineFromSourceMap
}
