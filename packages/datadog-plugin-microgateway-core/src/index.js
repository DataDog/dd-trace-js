'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class MicrogatewayCorePlugin extends RouterPlugin {
  static id = 'microgateway-core'
  static framework = 'microgateway'
}

module.exports = MicrogatewayCorePlugin
