'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const producerPlugin = require('./producer')
const consumerPlugin = require('./consumer')

class MqttPlugin extends CompositePlugin {
  static id = 'mqtt'
  static plugins = {
    ...producerPlugin,
    ...consumerPlugin,
  }
}

module.exports = MqttPlugin
