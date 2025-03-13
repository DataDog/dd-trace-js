'use strict'

const Module = require('module')
const { pathToFileURL } = require('url')
const { MessageChannel } = require('worker_threads')
const shimmer = require('../../../../../datadog-shimmer')
const { isPrivateModule, isNotLibraryFile } = require('./filter')
const { csiMethods } = require('./csi-methods')
const { getName } = require('../telemetry/verbosity')
const { incrementTelemetryIfNeeded } = require('./rewriter-telemetry')
const dc = require('dc-polyfill')
const log = require('../../../log')
const { isMainThread } = require('worker_threads')
const { LOG_MESSAGE, REWRITTEN_MESSAGE } = require('./constants')

const hardcodedSecretCh = dc.channel('datadog:secrets:result')
let rewriter
let unwrapCompile = () => {}
let getPrepareStackTrace, cacheRewrittenSourceMap
let kSymbolPrepareStackTrace
let esmRewriterEnabled = false

function isFlagPresent (flag) {
  return process.env.NODE_OPTIONS?.includes(flag) ||
    process.execArgv?.some(arg => arg.includes(flag))
}

let getRewriterOriginalPathAndLineFromSourceMap = function (path, line, column) {
  return { path, line, column }
}

function setGetOriginalPathAndLineFromSourceMapFunction (chainSourceMap, { getOriginalPathAndLineFromSourceMap }) {
  if (!getOriginalPathAndLineFromSourceMap) return

  getRewriterOriginalPathAndLineFromSourceMap = chainSourceMap ? (path, line, column) => {
      // if --enable-source-maps is present stacktraces of the rewritten files contain the original path, file and
      // column because the sourcemap chaining is done during the rewriting process so we can skip it
      if (isPrivateModule(path) && isNotLibraryFile(path)) {
        return { path, line, column }
      } else {
        return getOriginalPathAndLineFromSourceMap(path, line, column)
      }
    } : getOriginalPathAndLineFromSourceMap
}

function getRewriter (telemetryVerbosity) {
  if (!rewriter) {
    try {
      const iastRewriter = require('@datadog/wasm-js-rewriter')
      const Rewriter = iastRewriter.Rewriter
      getPrepareStackTrace = iastRewriter.getPrepareStackTrace
      kSymbolPrepareStackTrace = iastRewriter.kSymbolPrepareStackTrace
      cacheRewrittenSourceMap = iastRewriter.cacheRewrittenSourceMap

      const chainSourceMap = isFlagPresent('--enable-source-maps')
      setGetOriginalPathAndLineFromSourceMapFunction(chainSourceMap, iastRewriter)

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
  let delegate = function (content, filename) {
    try {
      if (isPrivateModule(filename) && isNotLibraryFile(filename)) {
        const rewritten = rewriter.rewrite(content, filename, ['iast'])

        incrementTelemetryIfNeeded(rewritten.metrics)

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

  const shim = function () {
    return delegate.apply(this, arguments)
  }

  unwrapCompile = function () {
    delegate = compileMethod
  }

  return shim
}

function esmRewritePostProcess (rewritten, filename) {
  const { literalsResult, metrics } = rewritten

  if (metrics?.status === 'modified') {
    if (filename.startsWith('file://')) {
      filename = filename.substring(7)
    }

    cacheRewrittenSourceMap(filename, rewritten.content)
  }

  incrementTelemetryIfNeeded(metrics)

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

function isEsmConfigured () {
  const hasLoaderArg = isFlagPresent('--loader') || isFlagPresent('--experimental-loader')
  if (hasLoaderArg) return true

  const initializeLoaded = Object.keys(require.cache).find(file => file.includes('import-in-the-middle/hook.js'))
  return !!initializeLoaded
}

function enableEsmRewriter (telemetryVerbosity) {
  if (isMainThread && Module.register && !esmRewriterEnabled && isEsmConfigured()) {
    esmRewriterEnabled = true

    const { port1, port2 } = new MessageChannel()

    port1.on('message', (message) => {
      const { type, data } = message
      switch (type) {
        case LOG_MESSAGE:
          log[data.level]?.(...data.messages)
          break

        case REWRITTEN_MESSAGE:
          esmRewritePostProcess(data.rewritten, data.url)
          break
      }
    })

    port1.unref()
    port2.unref()

    try {
      Module.register('./rewriter-esm.mjs', {
        parentURL: pathToFileURL(__filename),
        transferList: [port2],
        data: {
          port: port2,
          csiMethods,
          telemetryVerbosity,
          chainSourceMap: isFlagPresent('--enable-source-maps')
        }
      })
    } catch (e) {
      log.error('[ASM] Error enabling ESM Rewriter', e)
      port1.close()
      port2.close()
    }
  }
}

function disableRewriter () {
  unwrapCompile()

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
