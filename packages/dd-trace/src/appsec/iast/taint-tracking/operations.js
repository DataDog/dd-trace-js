'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const iastLog = require('../iast-log')
const iastTelemetry = require('../telemetry')
const { REQUEST_TAINTED } = require('../telemetry/iast-metric')
const { isInfoAllowed } = require('../telemetry/verbosity')
const { getTaintTrackingImpl, getTaintTrackingNoop } = require('./taint-tracking-impl')

function createTransaction (id, iastContext) {
  if (id && iastContext) {
    iastContext[IAST_TRANSACTION_ID] = TaintedUtils.createTransaction(id)
  }
}

let onRemoveTransaction = (transactionId, iastContext) => {}

function onRemoveTransactionInformationTelemetry (transactionId, iastContext) {
  const metrics = TaintedUtils.getMetrics(transactionId, iastTelemetry.verbosity)
  if (metrics && metrics.requestCount) {
    REQUEST_TAINTED.add(metrics.requestCount, null, iastContext)
  }
}

function removeTransaction (iastContext) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]

    onRemoveTransaction(transactionId, iastContext)

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

function taintObject (iastContext, object, type, keyTainting, keyType) {
  let result = object
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    const queue = [{ parent: null, property: null, value: object }]
    const visited = new WeakSet()
    while (queue.length > 0) {
      const { parent, property, value, key } = queue.pop()
      if (value === null) {
        continue
      }
      try {
        if (typeof value === 'string') {
          const tainted = TaintedUtils.newTaintedString(transactionId, value, property, type)
          if (!parent) {
            result = tainted
          } else {
            if (keyTainting && key) {
              const taintedProperty = TaintedUtils.newTaintedString(transactionId, key, property, keyType)
              parent[taintedProperty] = tainted
            } else {
              parent[key] = tainted
            }
          }
        } else if (typeof value === 'object' && !visited.has(value)) {
          visited.add(value)
          const keys = Object.keys(value)
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i]
            queue.push({ parent: value, property: property ? `${property}.${key}` : key, value: value[key], key })
          }
          if (parent && keyTainting && key) {
            const taintedProperty = TaintedUtils.newTaintedString(transactionId, key, property, keyType)
            parent[taintedProperty] = value
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

function addSecureMark (iastContext, string, mark) {
  if (iastContext && iastContext[IAST_TRANSACTION_ID]) {
    const transactionId = iastContext[IAST_TRANSACTION_ID]
    return TaintedUtils.addSecureMarksToTaintedString(transactionId, string, mark)
  }
  return string
}

function enableTaintOperations (telemetryVerbosity) {
  if (isInfoAllowed(telemetryVerbosity)) {
    onRemoveTransaction = onRemoveTransactionInformationTelemetry
  }

  global._ddiast = getTaintTrackingImpl(telemetryVerbosity)
}

function disableTaintOperations () {
  global._ddiast = getTaintTrackingNoop()
}

function setMaxTransactions (transactions) {
  if (!transactions) {
    return
  }

  TaintedUtils.setMaxTransactions(transactions)
}

module.exports = {
  addSecureMark,
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
