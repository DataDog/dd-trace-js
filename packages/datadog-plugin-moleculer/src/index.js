'use strict'

// TODO: support https://moleculer.services/docs/0.13/actions.html#Streaming

const MoleculerServerPlugin = require('./server')
const MoleculerClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class MoleculerPlugin extends CompositePlugin {
  static get name () { return 'moleculer' }
  static get plugins () {
    return {
      server: MoleculerServerPlugin,
      client: MoleculerClientPlugin
    }
  }
}

module.exports = MoleculerPlugin
