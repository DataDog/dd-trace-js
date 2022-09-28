'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class RheaPlugin extends Plugin {
  static get name () { return 'rhea' }

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

module.exports = RheaPlugin
