'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const log = require('../../../log')

function noop (res) { return res }
const TaintTrackingDummy = {
  plusOperator: noop,
  trim: noop,
  trimEnd: noop
}

function getTransactionId () {
  const store = storage.getStore()
  const iastContext = iastContextFunctions.getIastContext(store)
  return iastContext && iastContext[iastContextFunctions.IAST_TRANSACTION_ID]
}

function getFilteredCsiFn (cb, filter) {
  return function csiCall (res, fn, target, ...rest) {
    try {
      if (filter(res, fn, target)) { return res }
      const transactionId = getTransactionId()
      if (transactionId) {
        return cb(transactionId, res, ...rest)
      }
    } catch (e) {
      log.debug(e)
    }
    return res
  }
}

function notString () {
  return Array.prototype.some.call(arguments, (p) => typeof p !== 'string')
}

function isValidCsiMethod (fn, ...protos) {
  return protos.some(proto => fn === proto)
}

function getCsiFn (cb, ...protos) {
  return getFilteredCsiFn(cb, (res, fn, target) => notString(res, target) || !isValidCsiMethod(fn, ...protos))
}

function getPlusOperatorFn (cb) {
  return getFilteredCsiFn(cb, (res, op1, op2) => notString(res) || (notString(op1) && notString(op2)))
}

const TaintTracking = {
  plusOperator: getPlusOperatorFn(
    (transactionId, res, op1, op2) => TaintedUtils.concat(transactionId, res, op1, op2)
  ),
  trim: getCsiFn(
    (transactionId, res, target) => TaintedUtils.trim(transactionId, res, target),
    String.prototype.trim,
    String.prototype.trimStart
  ),
  trimEnd: getCsiFn(
    (transactionId, res, target) => TaintedUtils.trimEnd(transactionId, res, target),
    String.prototype.trimEnd
  )
}

module.exports = {
  TaintTracking,
  TaintTrackingDummy
}
