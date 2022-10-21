'use strict'

const Module = require('module')
const shimmer = require('../../../../../datadog-shimmer')
const TaintTrackingFilter = require('./filter')

let Rewriter
let getPrepareStackTrace
try {
  const iastRewriter = require('@datadog/native-iast-rewriter')
  Rewriter = iastRewriter.Rewriter
  getPrepareStackTrace = iastRewriter.getPrepareStackTrace
} catch(e) {
  log.error(e)
}

const originalPrepareStackTrace = Error.prepareStackTrace
function getPrepareStackTraceAccessor() {
    let actual = getPrepareStackTrace(originalPrepareStackTrace)
    return  {
        get() {
            return actual
        },
        set(value) {
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

const enableRewriter = function () {
  const rewriter = getRewriter()
  if (rewriter) {
    
    Object.defineProperty(global.Error, 'prepareStackTrace', getPrepareStackTraceAccessor())

    shimmer.wrap(Module.prototype, '_compile', compileMethod => function (content, filename) {
      try {
        if (TaintTrackingFilter.isPrivateModule(filename)) {
          content = rewriter.rewrite(content, filename)
        }
      } catch (e) {
        log.debug(e)
      }
      return compileMethod.apply(this, [content, filename])
    }
    )
  }
}

const disableRewriter = function () {
  shimmer.unwrap(Module.prototype, '_compile')
  Error.prepareStackTrace = originalPrepareStackTrace
}

module.exports = {
    enableRewriter, disableRewriter
}