'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')

const WSServerPlugin = require('./server')
const WSProducerPlugin = require('./producer')
const WSReceiverPlugin = require('./receiver')
const WSClosePlugin = require('./close')

class WSPlugin extends CompositePlugin {
  static get id () { return 'websocket' }
  static get plugins () {
    return {
      server: WSServerPlugin,
      producer: WSProducerPlugin,
      receiver: WSReceiverPlugin,
      close: WSClosePlugin
    }
  }

  configure (config) {
    return super.configure(config)
  }
}

module.exports = WSPlugin
