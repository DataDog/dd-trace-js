'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const log = require('../../../log')

function noop (res) { return res }
const TaintTrackingDummy = {
  plusOperator: noop,
  trim: noop,
  trimEnd: noop,
  concat: noop,
  substring: noop,
  substr: noop,
  slice: noop,
  replace: noop
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
        return cb(transactionId, res, target, ...rest)
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

function isValidCsiMethod (fn, protos) {
  return protos.some(proto => fn === proto)
}

function getCsiFn (cb, ...protos) {
  let filter
  if (!protos || protos.length === 0) {
    filter = (res, fn, target) => notString(res, target)
  } else if (protos.length === 1) {
    const protoFn = protos[0]
    filter = (res, fn, target) => notString(res, target) || fn !== protoFn
  } else {
    filter = (res, fn, target) => notString(res, target) || !isValidCsiMethod(fn, protos)
  }
  return getFilteredCsiFn(cb, filter)
}

function csiMethodsDefaults (names, excluded) {
  const impl = {}
  names.forEach(name => {
    if (excluded.indexOf(name) !== -1) return
    impl[name] = getCsiFn(
      (transactionId, res, target, ...rest) => TaintedUtils[name](transactionId, res, target, ...rest),
      String.prototype[name]
    )
  })
  return impl
}

const csiMethodsOverrides = {
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

  trim: getCsiFn(
    (transactionId, res, target) => TaintedUtils.trim(transactionId, res, target),
    String.prototype.trim,
    String.prototype.trimStart
  )
}

const TaintTracking = {
  ...csiMethodsDefaults(Object.keys(TaintTrackingDummy), Object.keys(csiMethodsOverrides)),
  ...csiMethodsOverrides
}

module.exports = {
  TaintTracking,
  TaintTrackingDummy
}
