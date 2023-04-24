'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const iastLog = require('../iast-log')
const { TaintTracking, TaintTrackingDummy } = require('./taint-tracking-impl')

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
      if (value === null) {
        continue
      }
      try {
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
      } catch (e) {
        iastLog.error(`Error visiting property : ${property}`).errorAndPublish(e)
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

function setMaxTransactions (transactions) {
  if (!transactions) {
    return
  }

  TaintedUtils.setMaxTransactions(transactions)
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
  setMaxTransactions,
  IAST_TRANSACTION_ID
}
