'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class KafkajsPlugin extends CompositePlugin {
  static get id () { return 'kafkajs' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = KafkajsPlugin
