const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const log = require('../../../log')
const TaintedUtils = require('@datadog/native-iast-taint-tracking')

const IAST_TRANSACTION_ID = Symbol('_dd.iast.transactionId')

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
        return TaintedUtils.concat(transactionId, res, op1, op2)
      }
    } catch (e) {
      log.debug(e)
    }
    return res
  }
}

function createTransaction (id, iastContext) {
  if (id && iastContext) {
    iastContext[IAST_TRANSACTION_ID] = TaintedUtils.createTransaction(id)
  }
}

function removeTransaction (iastContext) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    TaintedUtils.removeTransaction(transactionId)
    delete iastContext[IAST_TRANSACTION_ID]
  }
}

function newTaintedString (iastContext, string, name, type) {
  let result = string
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    result = TaintedUtils.newTaintedString(transactionId, string, name, type)
  } else {
    result = string
  }
  return result
}

function taintObject (iastContext, object, type) {
  let result = object
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    const queue = [{ parent: null, property: null, value: object }]
    const visited = new WeakSet()
    while (queue.length > 0) {
      const { parent, property, value } = queue.pop()
      if (typeof value === 'string') {
        const tainted = TaintedUtils.newTaintedString(transactionId, value, property, type)
        if (!parent) {
          result = tainted
        } else {
          parent[property] = tainted
        }
      } else if (typeof value === 'object' && !visited.has(value)) {
        visited.add(value)
        const keys = Object.keys(value)
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          queue.push({ parent: value, property: property ? `${property}.${key}` : key, value: value[key] })
        }
      }
    }
  }
  return result
}

function isTainted (iastContext, string) {
  let result = false
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    result = TaintedUtils.isTainted(transactionId, string)
  } else {
    result = false
  }
  return result
}

function getRanges (iastContext, string) {
  let result = []
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    result = TaintedUtils.getRanges(transactionId, string)
  } else {
    result = []
  }
  return result
}

function enableTaintOperations () {
  global._ddiast = TaintTracking
}

function disableTaintOperations () {
  global._ddiast = TaintTrackingDummy
}

module.exports = {
  createTransaction,
  removeTransaction,
  newTaintedString,
  taintObject,
  isTainted,
  getRanges,
  enableTaintOperations,
  disableTaintOperations,
  IAST_TRANSACTION_ID
}
