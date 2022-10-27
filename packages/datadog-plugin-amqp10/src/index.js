'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class Amqp10Plugin extends CompositePlugin {
  static get name () { return 'amqp10' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = Amqp10Plugin
