'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const { isValidCsiMethod } = require('./csi-methods')

const log = require('../../../log')

function noop (res) { return res }
const TaintTrackingDummy = {
  plusOperator: noop
}

function getTransactionId () {
  const store = storage.getStore()
  const iastContext = iastContextFunctions.getIastContext(store)
  return iastContext && iastContext[iastContextFunctions.IAST_TRANSACTION_ID]
}

function notString () {
  return [...arguments].some(p => typeof p !== 'string')
}

function getCsiFn (cb) {
  return function csiCall (res, fn, target) {
    try {
      if (notString(res, target) || isValidCsiMethod(fn)) { return res }
      const transactionId = getTransactionId()
      if (transactionId) {
        const [,, ...rest] = arguments
        return cb(transactionId, res, ...rest)
      }
    } catch (e) {
      log.debug(e)
    }
    return res
  }
}

const TaintTracking = {
  plusOperator: function (res, op1, op2) {
    try {
      if (notString(res) || (notString(op1) && notString(op2))) { return res }

      const transactionId = getTransactionId()
      if (transactionId) {
        return TaintedUtils.concat(transactionId, res, op1, op2)
      }
    } catch (e) {
      log.debug(e)
    }
    return res
  },
  trim: getCsiFn((transactionId, res, target) => TaintedUtils.trim(transactionId, res, target)),
  trimEnd: getCsiFn((transactionId, res, target) => TaintedUtils.trimEnd(transactionId, res, target))
}

module.exports = {
  TaintTracking,
  TaintTrackingDummy
}
