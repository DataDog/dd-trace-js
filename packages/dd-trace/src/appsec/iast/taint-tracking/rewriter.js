'use strict'

const Module = require('module')
const shimmer = require('../../../../../datadog-shimmer')
const log = require('../../../log')
const TaintTrackingFilter = require('./filter')

let Rewriter
let getPrepareStackTrace
try {
  const iastRewriter = require('@datadog/native-iast-rewriter')
  Rewriter = iastRewriter.Rewriter
  getPrepareStackTrace = iastRewriter.getPrepareStackTrace
} catch (e) {
  log.error(e)
}

const originalPrepareStackTrace = Error.prepareStackTrace
const getPrepareStackTraceAccessor = function() {
  let actual = getPrepareStackTrace(originalPrepareStackTrace)
  return {
    get () {
      return actual
    },
    set (value) {
      actual = getPrepareStackTrace(value)
    }
  }
}

let rewriter
const getRewriter = function () {
  if (!rewriter) {
    try {
      rewriter = new Rewriter()
    } catch (e) {
      log.warn(`Unable to initialize TaintTracking Rewriter: ${e.message}`)
    }
  }
  return rewriter
}

const getCompileMethodFn = function(compileMethod){
  return function (content, filename) {
    try {
      if (TaintTrackingFilter.isPrivateModule(filename)) {
        content = rewriter.rewrite(content, filename)
      }
    } catch (e) {
      log.debug(e)
    }
    return compileMethod.apply(this, [content, filename])
  }
}

const enableRewriter = function () {
  const rewriter = getRewriter()
  if (rewriter) {
    Object.defineProperty(global.Error, 'prepareStackTrace', getPrepareStackTraceAccessor())
    shimmer.wrap(Module.prototype, '_compile', compileMethod => getCompileMethodFn(compileMethod))
  }
}

const disableRewriter = function () {
  shimmer.unwrap(Module.prototype, '_compile')
  Error.prepareStackTrace = originalPrepareStackTrace
}

module.exports = {
  enableRewriter, disableRewriter
}
