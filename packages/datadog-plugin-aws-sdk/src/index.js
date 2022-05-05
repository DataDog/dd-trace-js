'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

const services = require('./services')

class AwsSdkPlugin extends Plugin {
  static get name () {
    return 'aws-sdk'
  }

  constructor (...args) {
    super(...args)
    this.services = {}
    for (const name in services) {
      const ServicePlugin = services[name]
      this.services[name] = new ServicePlugin(...args)
    }
  }

  configure (config) {
    for (const service of Object.values(this.services)) {
      service.configure(config)
    }
  }
}

module.exports = AwsSdkPlugin
