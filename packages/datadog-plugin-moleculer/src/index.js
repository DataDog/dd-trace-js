'use strict'

// TODO: support https://moleculer.services/docs/0.13/actions.html#Streaming

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const MoleculerServerPlugin = require('./server')
const MoleculerClientPlugin = require('./client')

class MoleculerPlugin extends CompositePlugin {
  static id = 'moleculer'
  static get plugins () {
    return {
      server: MoleculerServerPlugin,
      client: MoleculerClientPlugin
    }
  }
}

module.exports = MoleculerPlugin
