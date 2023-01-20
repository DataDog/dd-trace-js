'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const iastLog = require('../iast-log')
const { PropagationType, EXECUTED_PROPAGATION } = require('../iast-metric')

function noop (res) { return res }
// NOTE: methods of this object must be synchronized with csi-methods.js file definitions!
// Otherwise you may end up rewriting a method and not providing its rewritten implementation
const TaintTrackingDummy = {
  plusOperator: noop,
  concat: noop,
  replace: noop,
  slice: noop,
  substr: noop,
  substring: noop,
  trim: noop,
  trimEnd: noop
}

function getTransactionId (iastContext) {
  return iastContext && iastContext[iastContextFunctions.IAST_TRANSACTION_ID]
}

function getContextDefault () {
  const store = storage.getStore()
  return iastContextFunctions.getIastContext(store)
}

function getContextDebug () {
  const iastContext = getContextDefault()
  EXECUTED_PROPAGATION.increase(PropagationType.STRING, iastContext)
  return iastContext
}

function getFilteredCsiFn (cb, filter, getContext) {
  return function csiCall (res, fn, target, ...rest) {
    try {
      if (filter(res, fn, target)) { return res }

      const context = getContext()
      const transactionId = getTransactionId(context)
      if (transactionId) {
        return cb(transactionId, res, target, ...rest)
      }
    } catch (e) {
      iastLog.error(`Error invoking CSI ${target}`)
        .errorAndPublish(e)
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

function getCsiFn (cb, getContext, ...protos) {
  let filter
  if (!protos || protos.length === 0) {
    filter = (res, fn, target) => notString(res, target)
  } else if (protos.length === 1) {
    const protoFn = protos[0]
    filter = (res, fn, target) => notString(res, target) || fn !== protoFn
  } else {
    filter = (res, fn, target) => notString(res, target) || !isValidCsiMethod(fn, protos)
  }
  return getFilteredCsiFn(cb, filter, getContext)
}

function csiMethodsDefaults (names, excluded, getContext) {
  const impl = {}
  names.forEach(name => {
    if (excluded.indexOf(name) !== -1) return
    impl[name] = getCsiFn(
      (transactionId, res, target, ...rest) => TaintedUtils[name](transactionId, res, target, ...rest),
      getContext,
      String.prototype[name]
    )
  })
  return impl
}

function csiMethodsOverrides (getContext) {
  return {
    plusOperator: function (res, op1, op2) {
      try {
        const iastContext = getContext()
        if (notString(res) || (notString(op1) && notString(op2))) { return res }
        const transactionId = getTransactionId(iastContext)
        if (transactionId) {
          return TaintedUtils.concat(transactionId, res, op1, op2)
        }
      } catch (e) {
        iastLog.error(`Error invoking CSI plusOperator`)
          .errorAndPublish(e)
      }
      return res
    },

    trim: getCsiFn(
      (transactionId, res, target) => TaintedUtils.trim(transactionId, res, target),
      getContext,
      String.prototype.trim,
      String.prototype.trimStart
    )
  }
}

let overrides = csiMethodsOverrides(getContextDefault)
const TaintTracking = {
  ...csiMethodsDefaults(Object.keys(TaintTrackingDummy), Object.keys(overrides), getContextDefault),
  ...overrides
}

overrides = csiMethodsOverrides(getContextDebug)
const TaintTrackingDebug = {
  ...csiMethodsDefaults(Object.keys(TaintTrackingDummy), Object.keys(overrides), getContextDebug),
  ...overrides
}

module.exports = {
  TaintTracking,
  TaintTrackingDebug,
  TaintTrackingDummy
}
