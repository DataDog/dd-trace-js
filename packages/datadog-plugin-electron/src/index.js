'use strict'

const FetchPlugin = require('../../datadog-plugin-fetch/src')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class ElectronPlugin extends CompositePlugin {
  static id = 'electron'
  static get plugins () {
    return {
      net: ElectronNetPlugin
    }
  }
}

class ElectronNetPlugin extends CompositePlugin {
  static id = 'electron:net'
  static get plugins () {
    return {
      fetch: ElectronFetchPlugin
    }
  }
}

class ElectronFetchPlugin extends FetchPlugin {
  static id = 'electron:net:fetch'
  static component = 'electron'
  static operation = 'fetch'
  static prefix = 'tracing:apm:electron:net:fetch'
}

module.exports = ElectronPlugin
