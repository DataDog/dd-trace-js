'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ElectronIpcPlugin = require('./ipc')
const ElectronNetPlugin = require('./net')

class ElectronPlugin extends CompositePlugin {
  static id = 'electron'
  static get plugins () {
    return {
      net: ElectronNetPlugin,
      ipc: ElectronIpcPlugin
    }
  }
}

module.exports = ElectronPlugin
