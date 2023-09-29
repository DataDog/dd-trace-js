'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const tagJsonPayload = require('../../dd-trace/src/payload-tagging/tagger')

class FetchPlugin extends HttpClientPlugin {
  static get id () { return 'fetch' }
  static get prefix () { return `apm:fetch:request` }

  tagPayload (span, contentType, body) {
    const payloadTags = tagJsonPayload(body, contentType, this._tracerConfig.httpPayloadTagging)
    console.log(payloadTags)
    span.addTags(payloadTags)
  }

  addTraceSub (eventName, handler) {
    this.addSub(`apm:${this.constructor.id}:${this.operation}:${eventName}`, handler)
  }

  bindStart ({ message, body }) {
    const req = message.req
    const options = new URL(req.url)
    const headers = options.headers = Object.fromEntries(req.headers.entries())

    options.method = req.method

    message.args = { options }

    const store = super.bindStart(message)

    if (this._tracerConfig.httpPayloadTagging && body !== undefined) {
      const headers = Object.fromEntries(message.req.headers.entries())
      const contentType = headers['content-type']
      console.log(`ctype: ${contentType}`)
      this.tagPayload(store.span, contentType, body)
    }

    message.headers = headers
    message.req = new globalThis.Request(req, { headers })

    return store
  }
}

module.exports = FetchPlugin
