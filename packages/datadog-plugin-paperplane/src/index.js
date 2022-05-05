'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const PaperplaneLoggerPlugin = require('./logger')
const PaperplaneServerPlugin = require('./server')

class PaperplanePlugin extends Plugin {
  static get name () {
    return 'paperplane'
  }

  constructor (...args) {
    super(...args)

    this.server = new PaperplaneServerPlugin(...args)
    this.logger = new PaperplaneLoggerPlugin(...args)
  }

  configure (config) {
    this.server.configure(config)
    this.logger.configure(config)
  }
}

module.exports = PaperplanePlugin
