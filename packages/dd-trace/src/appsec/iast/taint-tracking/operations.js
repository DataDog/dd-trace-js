'use strict'

const dc = require('dc-polyfill')
const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const iastTelemetry = require('../telemetry')
const { REQUEST_TAINTED } = require('../telemetry/iast-metric')
const { isInfoAllowed } = require('../telemetry/verbosity')
const {
  getTaintTrackingImpl,
  getTaintTrackingNoop,
  lodashTaintTrackingHandler
} = require('./taint-tracking-impl')
const { taintObject } = require('./operations-taint-object')

const lodashOperationCh = dc.channel('datadog:lodash:operation')

function createTransaction (id, iastContext) {
  if (id && iastContext) {
    iastContext[IAST_TRANSACTION_ID] = TaintedUtils.createTransaction(id)
  }
}

let onRemoveTransaction = (transactionId, iastContext) => {}

function onRemoveTransactionInformationTelemetry (transactionId, iastContext) {
  const metrics = TaintedUtils.getMetrics(transactionId, iastTelemetry.verbosity)
  if (metrics?.requestCount) {
    REQUEST_TAINTED.inc(iastContext, metrics.requestCount)
  }
}

function removeTransaction (iastContext) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    onRemoveTransaction(transactionId, iastContext)

    TaintedUtils.removeTransaction(transactionId)
    delete iastContext[IAST_TRANSACTION_ID]
  }
}

function newTaintedString (iastContext, string, name, type) {
  let result
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    result = TaintedUtils.newTaintedString(transactionId, string, name, type)
  } else {
    result = string
  }
  return result
}

function newTaintedObject (iastContext, obj, name, type) {
  let result
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    result = TaintedUtils.newTaintedObject(transactionId, obj, name, type)
  } else {
    result = obj
  }
  return result
}

function isTainted (iastContext, string) {
  let result
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    result = TaintedUtils.isTainted(transactionId, string)
  } else {
    result = false
  }
  return result
}

function getRanges (iastContext, string) {
  let result
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    result = TaintedUtils.getRanges(transactionId, string)
  } else {
    result = []
  }
  return result
}

function addSecureMark (iastContext, string, mark) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    return TaintedUtils.addSecureMarksToTaintedString(transactionId, string, mark)
  }

  return string
}

function enableTaintOperations (telemetryVerbosity) {
  if (isInfoAllowed(telemetryVerbosity)) {
    onRemoveTransaction = onRemoveTransactionInformationTelemetry
  }

  global._ddiast = getTaintTrackingImpl(telemetryVerbosity)
  lodashOperationCh.subscribe(lodashTaintTrackingHandler)
}

function disableTaintOperations () {
  global._ddiast = getTaintTrackingNoop()
  lodashOperationCh.unsubscribe(lodashTaintTrackingHandler)
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
  newTaintedObject,
  taintObject,
  isTainted,
  getRanges,
  enableTaintOperations,
  disableTaintOperations,
  setMaxTransactions,
  IAST_TRANSACTION_ID
}
