'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const ClientPlugin = require('./client')

// TODO: Consider splitting channels for publish/receive in the instrumentation.
class AmqplibPlugin extends Plugin {
  static get name () { return 'amqplib' }

  constructor (...args) {
    super(...args)

    this.producer = new ProducerPlugin(...args)
    this.consumer = new ConsumerPlugin(...args)
    this.client = new ClientPlugin(...args)
  }

  configure (config) {
    this.producer.configure(config)
    this.consumer.configure(config)
    this.client.configure(config)
  }
}

module.exports = AmqplibPlugin
