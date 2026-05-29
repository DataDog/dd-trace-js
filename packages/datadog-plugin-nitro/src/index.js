'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const serverPlugin = require('./server')

class NitroPlugin extends CompositePlugin {
  static id = 'nitro'
  static plugins = {
    ...serverPlugin
  }
}

module.exports = NitroPlugin
