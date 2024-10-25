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
const kafkaConsumerPlugin = require('./plugins/kafka')

const kafkaContextPlugin = require('../context/kafka-ctx-plugin')

module.exports = {
  enableTaintTracking (config, telemetryVerbosity) {
    enableRewriter(telemetryVerbosity)
    enableTaintOperations(telemetryVerbosity)
    taintTrackingPlugin.enable()

    kafkaContextPlugin.enable()
    kafkaConsumerPlugin.enable()

    setMaxTransactions(config.maxConcurrentRequests)
  },
  disableTaintTracking () {
    disableRewriter()
    disableTaintOperations()
    taintTrackingPlugin.disable()

    kafkaContextPlugin.disable()
    kafkaConsumerPlugin.disable()
  },
  setMaxTransactions,
  createTransaction,
  removeTransaction,
  taintTrackingPlugin
}
