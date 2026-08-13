'use strict'

const CompositePlugin = require('../../plugins/composite')
const HttpClientPlugin = require('../../../../datadog-plugin-http/src/client')
const NativeWebServerPlugin = require('./web-server')

/**
 * Stands in for `datadog-plugin-http` when `DD_TRACE_EXPERIMENTAL_NATIVE_PLUGINS` is on.
 *
 * Only the server half is specialized. Outgoing requests keep the generic plugin: a
 * client span's shape varies with the target, so there is far less about it to infer, and
 * replacing it would buy little for the same work.
 */
class NativeHttpPlugin extends CompositePlugin {
  static id = 'http'

  static get plugins () {
    return { server: NativeWebServerPlugin, client: HttpClientPlugin }
  }
}

module.exports = NativeHttpPlugin
