'use strict'

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
    enableTaintOperations(telemetryVerbosity)
    taintTrackingPlugin.enable(config)

    kafkaContextPlugin.enable(config)
    kafkaConsumerPlugin.enable(config)

    setMaxTransactions(config.maxConcurrentRequests)
  },
  disableTaintTracking () {
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
