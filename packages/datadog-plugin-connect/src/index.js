'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class ConnectPlugin extends RouterPlugin {
  static id = 'connect'
}

module.exports = ConnectPlugin
