'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const producerPlugin = require('./producer')
const consumerPlugin = require('./consumer')

class NatsPlugin extends CompositePlugin {
  static id = 'nats'
  static plugins = {
    ...producerPlugin,
    consumer: consumerPlugin,
  }
}

module.exports = NatsPlugin
