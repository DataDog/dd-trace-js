'use strict'

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')

const tracer = require('./packages/dd-trace')
const createFlaggingProviderClass = require('./packages/dd-trace/src/openfeature/flagging_provider')

const config = tracer._tracer._config

if (!config) {
  throw new Error('dd-trace/openfeature must be required after tracer.init().')
}

const FlaggingProvider = createFlaggingProviderClass(DatadogNodeServerProvider)

module.exports = new FlaggingProvider(tracer._tracer, config)
