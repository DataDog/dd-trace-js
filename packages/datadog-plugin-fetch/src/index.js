'use strict'

const { isTypedArray } = require('util/types')
const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const { getBodyRequestTags, isJSONContentType } = require('../../dd-trace/src/payload-tagging/tagger')

class FetchPlugin extends HttpClientPlugin {
  static get id () { return 'fetch' }
  static get prefix () { return `apm:fetch:request` }

  stringFromBody (body) {
    if (body === undefined) return undefined
    if (body instanceof String) return body.toString()
    if (isTypedArray(body)) { return Buffer.from(body).toString() }
    return body
  }

  async decodeBody (body) {
    if (body instanceof ReadableStream) {
      const buffers = []
      for await (const chunk of body) {
        buffers.push(chunk)
      }
      return ''.concat(buffers.map(uintArr => Buffer.from(uintArr).toString()))
    } else if (body instanceof Blob) {
      return body.text()
    } else {
      return this.stringFromBody(body)
    }
  }

  tagPayload (span, contentType, body) {
    const opts = {
      filter: this._tracerConfig.httpPayloadTagging,
      maxDepth: this._tracerConfig.httpPayloadMaxDepth
    }
    const payloadTags = getBodyRequestTags(body, contentType, opts)
    span.addTags(payloadTags)
  }

  addTraceSub (eventName, handler) {
    this.addSub(`apm:${this.constructor.id}:${this.operation}:${eventName}`, handler)
  }

  bindStart ({ message, body }) {
    const req = message.req
    const options = new URL(req.url)
    const headers = options.headers = Object.fromEntries(req.headers.entries())
    const contentType = headers['content-type']

    options.method = req.method

    message.args = { options }

    const store = super.bindStart(message)

    if (
      this._tracerConfig.httpPayloadTagging &&
      body !== undefined &&
      isJSONContentType(contentType)
    ) {
      this.decodeBody(body)
        .then(bodyAsString => this.tagPayload(store.span, contentType, bodyAsString))
        .catch(err => { throw err })
    }
    message.headers = headers
    message.req = new globalThis.Request(req, { headers })

    return store
  }
}

module.exports = FetchPlugin
