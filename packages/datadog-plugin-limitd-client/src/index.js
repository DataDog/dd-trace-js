'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')

class LimitdClientPlugin extends ServerPlugin {
  static get id () { return 'limitd-client' }
  static get operation () { return 'callback' }

  bindStart (ctx) {
    ctx.parentStore = storage('legacy').getStore()
    return ctx.parentStore
  }

  bindFinish (ctx) {
    return ctx.parentStore
  }
}

module.exports = LimitdClientPlugin
