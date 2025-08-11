'use strict'

const { storage } = require('../../datadog-core')
const RouterPlugin = require('../../datadog-plugin-router/src')

class HapiPlugin extends RouterPlugin {
  static id = 'hapi'

  constructor (...args) {
    super(...args)

    this._requestSpans = new WeakMap()

    this.addSub('apm:hapi:request:handle', ({ req }) => {
      const store = storage('legacy').getStore()
      const span = store && store.span

      this.setFramework(req, 'hapi')
      this._requestSpans.set(req, span)
    })

    this.addSub('apm:hapi:request:error', error => {
      if (!error || !error.isBoom || !this.config.validateStatus(error.output.statusCode)) {
        this.addError(error)
      }
    })

    this.addBind('apm:hapi:extension:start', ({ req }) => {
      return this._requestSpans.get(req)
    })
  }
}

module.exports = HapiPlugin
