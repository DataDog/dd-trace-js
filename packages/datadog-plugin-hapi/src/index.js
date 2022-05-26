'use strict'

const { storage } = require('../../datadog-core')
const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

class HapiPlugin extends RouterPlugin {
  static get name () {
    return 'hapi'
  }

  constructor (...args) {
    super(...args)

    this._requestSpans = new WeakMap()

    this.addSub('apm:hapi:request:handle', ({ req }) => {
      const store = storage.getStore()
      const span = store && store.span

      this.setFramework(req, 'hapi', this.config)
      this._requestSpans.set(req, span)
    })

    this.addSub('apm:hapi:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })

    this.addSub(`apm:hapi:request:error`, this.addError)

    this.addSub('apm:hapi:extension:enter', ({ req }) => {
      this.enter(this._requestSpans.get(req))
    })
  }
}

module.exports = HapiPlugin
