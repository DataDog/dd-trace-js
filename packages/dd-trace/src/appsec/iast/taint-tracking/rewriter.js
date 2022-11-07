'use strict'

const Module = require('module')
const shimmer = require('../../../../../datadog-shimmer')
const log = require('../../../log')
const { isPrivateModule, isNotLibraryFile } = require('./filter')

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

let rewriter
let getPrepareStackTrace
function getRewriter () {
  if (!rewriter) {
    try {
      const iastRewriter = require('@datadog/native-iast-rewriter')
      const Rewriter = iastRewriter.Rewriter
      getPrepareStackTrace = iastRewriter.getPrepareStackTrace
      rewriter = new Rewriter()
    } catch (e) {
      log.warn(`Unable to initialize TaintTracking Rewriter: ${e.message}`)
    }
  }
  return rewriter
}

function getCompileMethodFn (compileMethod) {
  return function (content, filename) {
    try {
      if (isPrivateModule(filename) && isNotLibraryFile(filename)) {
        content = rewriter.rewrite(content, filename)
      }
    } catch (e) {
      log.debug(e)
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
