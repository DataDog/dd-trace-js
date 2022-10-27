'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class RheaPlugin extends CompositePlugin {
  static get name () { return 'rhea' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = RheaPlugin
