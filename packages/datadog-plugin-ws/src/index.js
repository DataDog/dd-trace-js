'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')

const WSServerPlugin = require('./server')
const WSProducerPlugin = require('./producer')

class WSPlugin extends CompositePlugin {
  static get id () { return 'websocket' }
  static get plugins () {
    return {
      server: WSServerPlugin,
      producer: WSProducerPlugin
    }
  }

  configure (config) {
    return super.configure(config)
  }
}

module.exports = WSPlugin
