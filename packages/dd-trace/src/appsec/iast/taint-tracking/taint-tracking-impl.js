'use strict'

const dc = require('dc-polyfill')
const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const iastLog = require('../iast-log')
const { EXECUTED_PROPAGATION } = require('../telemetry/iast-metric')
const { isDebugAllowed } = require('../telemetry/verbosity')
const { JSON_VALUE } = require('./source-types')

const mathRandomCallCh = dc.channel('datadog:random:call')

function noop (res) { return res }
// NOTE: methods of this object must be synchronized with csi-methods.js file definitions!
// Otherwise you may end up rewriting a method and not providing its rewritten implementation
const TaintTrackingNoop = {
  plusOperator: noop,
  concat: noop,
  random: noop,
  replace: noop,
  slice: noop,
  substr: noop,
  substring: noop,
  trim: noop,
  trimEnd: noop,
  parse: noop
}

function getTransactionId (iastContext) {
  return iastContext?.[iastContextFunctions.IAST_TRANSACTION_ID]
}

function getContextDefault () {
  const store = storage.getStore()
  return iastContextFunctions.getIastContext(store)
}

function getContextDebug () {
  const iastContext = getContextDefault()
  EXECUTED_PROPAGATION.inc(null, iastContext)
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

function csiMethodsOverrides (getContext, taintObject) {
  return {
    plusOperator: function (res, op1, op2) {
      try {
        if (notString(res) || (notString(op1) && notString(op2))) { return res }
        const iastContext = getContext()
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
    ),

    random: function (res, fn) {
      if (mathRandomCallCh.hasSubscribers) {
        mathRandomCallCh.publish({ fn })
      }
      return res
    },

    parse: function (res, fn, target, json) {
      if (fn === JSON.parse) {
        const iastContext = getContext()
        const transactionId = getTransactionId(iastContext)
        if (transactionId && TaintedUtils.isTainted(transactionId, json)) {
          res = taintObject(iastContext, res, JSON_VALUE)
        }
      }

      return res
    }
  }
}

function createImplWith (getContext, taintObject) {
  const methodNames = Object.keys(TaintTrackingNoop)
  const overrides = csiMethodsOverrides(getContext, taintObject)

  // impls could be cached but at the moment there is only one invocation to getTaintTrackingImpl
  return {
    ...csiMethodsDefaults(methodNames, Object.keys(overrides), getContext),
    ...overrides
  }
}

function getTaintTrackingImpl (telemetryVerbosity, taintObject = noop, dummy = false) {
  if (dummy) return TaintTrackingNoop

  // with Verbosity.DEBUG every invocation of a TaintedUtils method increases the EXECUTED_PROPAGATION metric
  return isDebugAllowed(telemetryVerbosity)
    ? createImplWith(getContextDebug, taintObject)
    : createImplWith(getContextDefault, taintObject)
}

function getTaintTrackingNoop () {
  return getTaintTrackingImpl(null, noop, true)
}

module.exports = {
  getTaintTrackingImpl,
  getTaintTrackingNoop
}
