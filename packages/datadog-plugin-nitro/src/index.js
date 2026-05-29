'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const { NitroH3ServerPlugin } = require('./server')

class NitroPlugin extends CompositePlugin {
  static id = 'nitro'
  static plugins = {
    server: NitroH3ServerPlugin,
  }
}

module.exports = NitroPlugin
