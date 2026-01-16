'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')

class PuppeteerPlugin extends CompositePlugin {
  static id = 'puppeteer'
  static plugins = {
    ...clientPlugin
  }
}

module.exports = PuppeteerPlugin