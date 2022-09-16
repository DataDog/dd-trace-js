'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class Amqp10Plugin extends Plugin {
  static get name () {
    return 'amqp10'
  }

  constructor (...args) {
    super(...args)

    this.producer = new ProducerPlugin(...args)
    this.consumer = new ConsumerPlugin(...args)
  }

  configure (config) {
    this.producer.configure(config)
    this.consumer.configure(config)
  }
}

module.exports = Amqp10Plugin
