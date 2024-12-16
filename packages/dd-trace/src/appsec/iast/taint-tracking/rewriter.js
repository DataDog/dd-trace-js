'use strict'

const Module = require('module')
const { pathToFileURL } = require('url')
const { MessageChannel } = require('worker_threads')
const shimmer = require('../../../../../datadog-shimmer')
const { isPrivateModule, isNotLibraryFile } = require('./filter')
const { csiMethods } = require('./csi-methods')
const { getName } = require('../telemetry/verbosity')
const { getRewriteFunction } = require('./rewriter-telemetry')
const dc = require('dc-polyfill')
const log = require('../../../log')
const { isMainThread } = require('worker_threads')

const hardcodedSecretCh = dc.channel('datadog:secrets:result')
let rewriter
let getPrepareStackTrace
let kSymbolPrepareStackTrace
let esmRewriterEnabled = false

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
      kSymbolPrepareStackTrace = iastRewriter.kSymbolPrepareStackTrace

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
      log.error('[ASM] Unable to initialize TaintTracking Rewriter', e)
    }
  }
  return rewriter
}

let originalPrepareStackTrace
function getPrepareStackTraceAccessor () {
  originalPrepareStackTrace = Error.prepareStackTrace
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

        if (rewritten?.literalsResult && hardcodedSecretCh.hasSubscribers) {
          hardcodedSecretCh.publish(rewritten.literalsResult)
        }

        if (rewritten?.content) {
          return compileMethod.apply(this, [rewritten.content, filename])
        }
      }
    } catch (e) {
      log.error('[ASM] Error rewriting file %s', filename, e)
    }
    return compileMethod.apply(this, [content, filename])
  }
}

function rewriteForESM (content, filename) {
  const rewriteFn = getRewriteFunction(rewriter)
  try {
    if (isPrivateModule(filename) && isNotLibraryFile(filename)) {
      const rewritten = rewriteFn(content, filename)

      if (rewritten?.literalsResult && hardcodedSecretCh.hasSubscribers) {
        hardcodedSecretCh.publish(rewritten.literalsResult)
      }

      if (rewritten?.content) {
        return rewritten.content
      }
    }
  } catch (e) {
    log.error('[ASM] Error rewriting file %s', filename, e)
  }

  return content
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
    enableEsmRewriter()
  } catch (e) {
    log.error('[ASM] Error enabling TaintTracking Rewriter', e)
  }
}

function enableEsmRewriter () {
  if (isMainThread && Module.register && !esmRewriterEnabled) {
    esmRewriterEnabled = true
    const { port1, port2 } = new MessageChannel()
    port1.on('message', (message) => {
      message.source = rewriteForESM(message.source, message.url)
      port1.postMessage(message)
    })
    port1.unref()
    port2.unref()

    process.nextTick(() => {
      try {
        Module.register('./rewriter-esm.mjs', {
          parentURL: pathToFileURL(__filename),
          data: { port2 },
          transferList: [port2]
        })
      } catch (e) {
        log.error('[ASM] Error enabling ESM Rewriter', e)
      }
    })
  }
}

function disableRewriter () {
  shimmer.unwrap(Module.prototype, '_compile')

  if (!Error.prepareStackTrace?.[kSymbolPrepareStackTrace]) return

  try {
    delete Error.prepareStackTrace

    Error.prepareStackTrace = originalPrepareStackTrace
  } catch (e) {
    log.warn('[ASM] Error disabling TaintTracking rewriter', e)
  }
}

function getOriginalPathAndLineFromSourceMap ({ path, line, column }) {
  return getRewriterOriginalPathAndLineFromSourceMap(path, line, column)
}

module.exports = {
  enableRewriter, disableRewriter, getOriginalPathAndLineFromSourceMap
}
