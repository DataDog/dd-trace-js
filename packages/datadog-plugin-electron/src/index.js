'use strict'

const { DD_MAJOR } = require('../../../version')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ElectronIpcPlugin = require('./ipc')
const ElectronNetPlugin = require('./net')

class ElectronPlugin extends CompositePlugin {
  static id = 'electron'
  static experimental = DD_MAJOR >= 7
  static get plugins () {
    return {
      net: ElectronNetPlugin,
      ipc: ElectronIpcPlugin,
    }
  }
}

module.exports = ElectronPlugin
