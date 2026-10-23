'use strict'

const kafkaContextPlugin = require('../context/kafka-ctx-plugin')
const {
  createTransaction,
  removeTransaction,
  setMaxTransactions,
  enableTaintOperations,
  disableTaintOperations,
} = require('./operations')

const taintTrackingPlugin = require('./plugin')
const kafkaConsumerPlugin = require('./plugins/kafka')

module.exports = {
  enableTaintTracking (config, telemetryVerbosity) {
    enableTaintOperations(telemetryVerbosity)
    taintTrackingPlugin.enable(config)

    kafkaContextPlugin.enable(config)
    kafkaConsumerPlugin.enable(config)

    setMaxTransactions(config.DD_IAST_MAX_CONCURRENT_REQUESTS)
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
  taintTrackingPlugin,
}
