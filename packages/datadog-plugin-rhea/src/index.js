'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class RheaPlugin extends CompositePlugin {
  static id = 'rhea'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = RheaPlugin
