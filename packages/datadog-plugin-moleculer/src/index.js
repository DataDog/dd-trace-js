'use strict'

// TODO: support https://moleculer.services/docs/0.13/actions.html#Streaming

const Plugin = require('../../dd-trace/src/plugins/plugin')
const MoleculerServerPlugin = require('./server')
const MoleculerClientPlugin = require('./client')

class MoleculerPlugin extends Plugin {
  static get name () {
    return 'moleculer'
  }

  constructor (...args) {
    super(...args)

    this.server = new MoleculerServerPlugin(...args)
    this.client = new MoleculerClientPlugin(...args)
  }

  configure (config) {
    const clientConfig = config.client === false ? false : {
      ...config,
      ...config.client
    }

    const serverConfig = config.server === false ? false : {
      ...config,
      ...config.server
    }

    this.server.configure(serverConfig)
    this.client.configure(clientConfig)
  }
}

module.exports = MoleculerPlugin
