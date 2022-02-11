'use strict'

const { LOG } = require('../../../ext/formats')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

module.exports = class BunyanPlugin extends Plugin {
  static get name() {
    return 'bunyan'
  }

  constructor (...args) {
    super(...args)
    this.addSub('apm:bunyan:log', ({ logMessage }) => {
      if (this.tracer._logInjection) {
        this.tracer.inject(storage.getStore().span, LOG, logMessage)
      }
    })
  }
}
