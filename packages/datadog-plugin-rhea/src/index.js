'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class RheaPlugin extends CompositePlugin {
  static id = 'rhea'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
    }
  }
}

module.exports = RheaPlugin
