'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const ExpressRequestPlugin = require('./request')
const ExpressMiddlewarePlugin = require('./middleware')

class ExpressPlugin extends Plugin {
  static get name () {
    return 'express'
  }
  constructor (...args) {
    super(...args)
    this.request = new ExpressRequestPlugin(...args)
    this.middleware = new ExpressMiddlewarePlugin(...args)
  }
  configure (config) {
    this.request.configure(config)
    this.middleware.configure(config)
  }
}

module.exports = ExpressPlugin
