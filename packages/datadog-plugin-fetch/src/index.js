'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const { HTTP_HEADERS } = require('../../../ext/formats')

class FetchPlugin extends HttpClientPlugin {
  static get id () { return 'fetch' }

  addTraceSub (eventName, handler) {
    this.addSub(`apm:${this.constructor.id}:${this.operation}:${eventName}`, handler)
  }

  start (message) {
    const req = message.req
    const options = new URL(req.url)
    const headers = options.headers = Object.fromEntries(req.headers.entries())

    const args = { options }

    super.start({ args })

    message.req = new globalThis.Request(req, { headers })
  }

  _inject (span, headers) {
    const carrier = {}

    this.tracer.inject(span, HTTP_HEADERS, carrier)

    for (const name in carrier) {
      headers.append(name, carrier[name])
    }
  }
}

module.exports = FetchPlugin
