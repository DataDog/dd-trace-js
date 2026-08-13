'use strict'

const CompositePlugin = require('../../plugins/composite')
const { MIDDLEWARE_EXPRESS } = require('../wire')
const NativeMiddlewarePlugin = require('./middleware')

/**
 * Stands in for `datadog-plugin-express` when native plugins are on.
 *
 * Code origin for spans is dropped: it hangs `_dd.code_origin.*` tags on a `Span` object,
 * and there is no span to hang them on. Framework detection stays — the web-server plugin
 * subscribes to `apm:express:request:handle` itself to learn the request is express's, so
 * this composite only has to cover the middleware.
 */
class NativeExpressMiddlewarePlugin extends NativeMiddlewarePlugin {
  static id = 'express'

  constructor () {
    super('express', MIDDLEWARE_EXPRESS)
  }
}

class NativeExpressPlugin extends CompositePlugin {
  static id = 'express'

  static get plugins () {
    return { tracing: NativeExpressMiddlewarePlugin }
  }
}

module.exports = NativeExpressPlugin
