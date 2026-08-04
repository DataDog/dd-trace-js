'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class NatsPlugin extends CompositePlugin {
  static id = 'nats'
  // Disabled by default — users must opt in via DD_TRACE_NATS_ENABLED=true
  // or `tracer.use('nats')`. Matches the feature parity dashboard policy.
  static experimental = true
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
    }
  }
}

module.exports = NatsPlugin
