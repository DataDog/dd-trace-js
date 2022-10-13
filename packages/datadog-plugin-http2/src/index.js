'use strict'

const Http2ServerPlugin = require('./server')
const Http2ClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class Http2Plugin extends CompositePlugin {
  static get name () { return 'http2' }
  static get plugins () {
    return {
      server: Http2ServerPlugin,
      client: Http2ClientPlugin
    }
  }
}

module.exports = Http2Plugin
