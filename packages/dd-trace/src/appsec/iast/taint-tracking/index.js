'use strict'

const { enableRewriter, disableRewriter } = require('./rewriter')
const {
  createTransaction,
  removeTransaction,
  setMaxTransactions,
  enableTaintOperations,
  disableTaintOperations
} = require('./operations')

const taintTrackingPlugin = require('./plugin')

module.exports = {
  enableTaintTracking (config, telemetryVerbosity) {
    enableRewriter(telemetryVerbosity)
    enableTaintOperations(telemetryVerbosity)
    taintTrackingPlugin.enable()
    setMaxTransactions(config.maxConcurrentRequests)
  },
  disableTaintTracking () {
    disableRewriter()
    disableTaintOperations()
    taintTrackingPlugin.disable()
  },
  setMaxTransactions: setMaxTransactions,
  createTransaction: createTransaction,
  removeTransaction: removeTransaction,
  taintTrackingPlugin
}
