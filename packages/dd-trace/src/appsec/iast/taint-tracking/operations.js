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
const { taintObject, taintQueryWithCache } = require('./operations-taint-object')

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
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  return transactionId ? TaintedUtils.newTaintedString(transactionId, string, name, type) : string
}

function newTaintedObject (iastContext, obj, name, type) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  return transactionId ? TaintedUtils.newTaintedObject(transactionId, obj, name, type) : obj
}

function isTainted (iastContext, string) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  return transactionId ? TaintedUtils.isTainted(transactionId, string) : false
}

function getRanges (iastContext, string) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  return transactionId ? TaintedUtils.getRanges(transactionId, string) : []
}

function addSecureMark (iastContext, string, mark, createNewTainted = true) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    return TaintedUtils.addSecureMarksToTaintedString(transactionId, string, mark, createNewTainted)
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
  taintQueryWithCache,
  isTainted,
  getRanges,
  enableTaintOperations,
  disableTaintOperations,
  setMaxTransactions,
  IAST_TRANSACTION_ID
}
