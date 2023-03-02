'use strict'

const Module = require('module')
const shimmer = require('../../../../../datadog-shimmer')
const log = require('../../../log')
const { isPrivateModule, isNotLibraryFile } = require('./filter')
const { csiMethods } = require('./csi-methods')

let rewriter
let getPrepareStackTrace
function getRewriter () {
  if (!rewriter) {
    try {
      const iastRewriter = require('@datadog/native-iast-rewriter')
      const Rewriter = iastRewriter.Rewriter
      getPrepareStackTrace = iastRewriter.getPrepareStackTrace
      rewriter = new Rewriter({ csiMethods })
    } catch (e) {
      log.warn(`Unable to initialize TaintTracking Rewriter: ${e.message}`)
    }
  }
  return rewriter
}

let originalPrepareStackTrace = Error.prepareStackTrace
function getPrepareStackTraceAccessor () {
  let actual = getPrepareStackTrace(originalPrepareStackTrace)
  return {
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
      log.error(e)
    }
    return compileMethod.apply(this, [content, filename])
  }
}

function enableRewriter () {
  const rewriter = getRewriter()
  if (rewriter) {
    Object.defineProperty(global.Error, 'prepareStackTrace', getPrepareStackTraceAccessor())
    shimmer.wrap(Module.prototype, '_compile', compileMethod => getCompileMethodFn(compileMethod))
  }
}

function disableRewriter () {
  shimmer.unwrap(Module.prototype, '_compile')
  Error.prepareStackTrace = originalPrepareStackTrace
}

module.exports = {
  enableRewriter, disableRewriter
}
