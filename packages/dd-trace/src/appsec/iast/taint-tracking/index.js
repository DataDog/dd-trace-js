'use strict'

const Module = require('module')

const shimmer = require('../../../../../datadog-shimmer')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const log = require('../../../log')

let Rewriter
let TaintedUtils
try {
  Rewriter = require('@datadog/native-iast-rewriter').Rewriter
  TaintedUtils = require('@datadog/native-iast-taint-tracking')
} catch(e) {
  log.error(e)
}
const TaintTrackingFilter = require('./taint-tracking-filter')

const IAST_TRANSACTION_ID = Symbol('_dd.iast.transactionId')

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
  // TODO: set prepareStackTrace
  if (rewriter) {
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
}

const noop = function (res) { return res }
const TaintTrackingDummy = {
  plusOperator: noop
}

const TaintTracking = {
  plusOperator: function (res, op1, op2) {
    try {
      if (typeof res !== 'string' ||
        (typeof op1 !== 'string' && typeof op2 !== 'string')) { return res }

      const store = storage.getStore()
      const iastContext = iastContextFunctions.getIastContext(store)
      const transactionId = iastContext && iastContext[IAST_TRANSACTION_ID]
      if (transactionId) {
        res = TaintedUtils.concat(transactionId, res, op1, op2)
      }
    } catch (e) {
      log.debug(e)
    }
    return res
  }
}

const createTransaction = function (id, iastContext) {
  if (id && iastContext) {
    const transactionId = TaintedUtils.createTransaction(id)
    iastContext[IAST_TRANSACTION_ID] = transactionId
  }
}

const removeTransaction = function (iastContext) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    TaintedUtils.removeTransaction(transactionId)
  }
}

const newTaintedString = function (iastContext, string, name, type) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    TaintedUtils.newTaintedString(transactionId, string, name, type)
  }
}

const isTainted = function (iastContext, string) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    return TaintedUtils.isTainted(transactionId, string)
  }
}

const getRanges = function (iastContext, string) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    return TaintedUtils.getRanges(transactionId, string)
  }
}

const enableTaintTracking = function () {
  if (TaintedUtils) {
    enableRewriter()
    global._ddiast = TaintTracking
  }
}

const disableTaintTracking = function () {
  disableRewriter()
  global._ddiast = TaintTrackingDummy
}

module.exports = {
  createTransaction,
  removeTransaction,
  enableTaintTracking,
  disableTaintTracking,
  newTaintedString,
  isTainted,
  getRanges,
  IAST_TRANSACTION_ID
}
