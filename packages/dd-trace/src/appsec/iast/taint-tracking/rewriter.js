'use strict'

const Module = require('module')
const { pathToFileURL } = require('url')
const { MessageChannel } = require('worker_threads')
const shimmer = require('../../../../../datadog-shimmer')
const { isPrivateModule, isNotLibraryFile } = require('./filter')
const { csiMethods } = require('./csi-methods')
const { getName, Verbosity } = require('../telemetry/verbosity')
const { getRewriteFunction } = require('./rewriter-telemetry')
const { INSTRUMENTED_PROPAGATION } = require('../telemetry/iast-metric')
const dc = require('dc-polyfill')
const log = require('../../../log')
const { isMainThread } = require('worker_threads')
const fs = require('fs')

const hardcodedSecretCh = dc.channel('datadog:secrets:result')
let rewriter
let getPrepareStackTrace, cacheRewrittenSourceMap
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
      cacheRewrittenSourceMap = iastRewriter.cacheRewrittenSourceMap

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

function esmRewritePostProcess (rewritten, filename, telemetryVerbosity) {
  if (!rewritten?.content) return

  const { literalsResult, metrics } = rewritten
  if (metrics?.status === 'modified') {
    if (filename.startsWith('file://')) {
      filename = filename.substring(7)
    }
    cacheRewrittenSourceMap(filename, rewritten.content)
  }

  if (telemetryVerbosity !== Verbosity.OFF) {
    if (metrics && metrics.instrumentedPropagation) {
      INSTRUMENTED_PROPAGATION.inc(undefined, metrics.instrumentedPropagation)
    }
  }

  if (literalsResult && hardcodedSecretCh.hasSubscribers) {
    hardcodedSecretCh.publish(literalsResult)
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
    enableEsmRewriter(telemetryVerbosity)
  } catch (e) {
    log.error('[ASM] Error enabling TaintTracking Rewriter', e)
  }
}

function enableEsmRewriter (telemetryVerbosity) {
  if (isMainThread && Module.register && !esmRewriterEnabled) {
    esmRewriterEnabled = true
    const { port1, port2 } = new MessageChannel()
    port1.on('message', (message) => {
      const { type, data } = message
      switch (type) {
        // TODO extract types to constants to be used here and in rewriter-esm.mjs
        case 'LOG':
          log[data.level]?.(...data.messages)
          break
        case 'REWRITTEN':
          esmRewritePostProcess(data.rewritten, data.url)
          break
      }
      // TODO this is going to be used to:
      //  - cache rewritten sourcemaps
      //  - create vulnerabilities with detected passwords
      //  - write logs coming from rewriter thread
      //  - message:
      //    - type: 'LOG' | 'REWRITTEN'
      //    - data: { level: 'error'..., messages: any[] } | { url, source, literalsResult }
      // console.log(JSON.stringify(message, null, 2))
      // message.source = rewriteForESM(message.source, message.url)
      // port1.postMessage(message)
    })
    port1.unref()
    port2.unref()

    const chainSourceMap = isFlagPresent('--enable-source-maps')
    const data = {
      port: port2,
      csiMethods,
      telemetryVerbosity,
      chainSourceMap
    }

    process.nextTick(() => {
      try {
        Module.register('./rewriter-esm.mjs', {
          parentURL: pathToFileURL(__filename),
          transferList: [port2],
          data
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
