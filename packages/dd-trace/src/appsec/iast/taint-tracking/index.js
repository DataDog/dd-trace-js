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
    return TaintedUtils.newTaintedString(transactionId, string, name, type)
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
