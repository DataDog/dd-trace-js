'use strict'

const { enableRewriter, disableRewriter } = require('./rewriter')
const { createTransaction,
  removeTransaction,
  setMaxTransactions,
  enableTaintOperations,
  disableTaintOperations } = require('./operations')

const taintTrackingPlugin = require('./plugin')

module.exports = {
  enableTaintTracking (config) {
    enableRewriter()
    enableTaintOperations()
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
  removeTransaction: removeTransaction
}
