'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')

class FetchPlugin extends HttpClientPlugin {
  static get id () { return 'fetch' }
  static get prefix () { return `apm:fetch:request` }

  addTraceSub (eventName, handler) {
    this.addSub(`apm:${this.constructor.id}:${this.operation}:${eventName}`, handler)
  }

  bindStart (message) {
    const req = message.req
    const options = new URL(req.url)
    const headers = options.headers = Object.fromEntries(req.headers.entries())

    options.method = req.method

    message.args = { options }

    const store = super.bindStart(message)

    message.headers = headers
    message.req = new globalThis.Request(req, { headers })

    return store
  }
}

module.exports = FetchPlugin
