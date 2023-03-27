'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const NetIPCPlugin = require('./ipc')
const NetTCPPlugin = require('./tcp')

class NetPlugin extends Plugin {
  static get id () { return 'net' }

  constructor (...args) {
    super(...args)

    this._ipc = new NetIPCPlugin(...args)
    this._tcp = new NetTCPPlugin(...args)
  }

  configure (config) {
    this._ipc.configure(config)
    this._tcp.configure(config)
  }
}

module.exports = NetPlugin
