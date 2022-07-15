'use strict'

// Plugin temporarily disabled. See https://github.com/DataDog/dd-trace-js/issues/312

const Plugin = require('../../dd-trace/src/plugins/plugin')

class Http2ServerPlugin extends Plugin {
  static get name () {
    return 'http2'
  }
}

module.exports = Http2ServerPlugin
