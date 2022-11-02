'use strict'

const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const log = require('../../../log')
const { enableRewriter, disableRewriter } = require('./rewriter')
const IAST_TRANSACTION_ID = Symbol('_dd.iast.transactionId')

let TaintedUtils
try {
  TaintedUtils = require('@datadog/native-iast-taint-tracking')
} catch (e) {
  log.error(e)
}

function noop (res) { return res }
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

function createTransaction (id, iastContext) {
  if (id && iastContext) {
    const transactionId = TaintedUtils.createTransaction(id)
    iastContext[IAST_TRANSACTION_ID] = transactionId
  }
}

function removeTransaction (iastContext) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    TaintedUtils.removeTransaction(transactionId)
  }
}

function newTaintedString (iastContext, string, name, type) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    return TaintedUtils.newTaintedString(transactionId, string, name, type)
  }
}

function isTainted (iastContext, string) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    return TaintedUtils.isTainted(transactionId, string)
  } else {
    return false
  }
}

function getRanges (iastContext, string) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    return TaintedUtils.getRanges(transactionId, string)
  }
}

function enableTaintTracking () {
  if (TaintedUtils) {
    enableRewriter()
    global._ddiast = TaintTracking
  }
}

function disableTaintTracking () {
  disableRewriter()
  global._ddiast = TaintTrackingDummy
}

function empty () {}

module.exports = {
  createTransaction: TaintTracking ? createTransaction : empty,
  removeTransaction: TaintTracking ? removeTransaction : empty,
  enableTaintTracking: TaintTracking ? enableTaintTracking : empty,
  disableTaintTracking: TaintTracking ? disableTaintTracking : empty,
  newTaintedString: TaintTracking ? newTaintedString : empty,
  isTainted: TaintTracking ? isTainted : empty,
  getRanges: TaintTracking ? getRanges : empty,
  IAST_TRANSACTION_ID
}
