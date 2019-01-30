'use strict'

const METHODS = require('methods').concat('use', 'route', 'param', 'all')
const web = require('./util/web')
const routerPlugin = require('./router')

function createWrapMethod (tracer, config) {
  config = web.normalizeConfig(config)

  function ddTrace (req, res, next) {
    web.instrument(tracer, config, req, res, 'express.request')

    next()
  }

  return function wrapMethod (original) {
    return function methodWithTrace () {
      if (!this._datadog_trace_patched && !this._router) {
        this._datadog_trace_patched = true
        this.use(ddTrace)
      }
      return original.apply(this, arguments)
    }
  }
}

function patch (express, tracer, config) {
  this.wrap(express.application, METHODS, createWrapMethod(tracer, config))
  routerPlugin.patch.call(this, { prototype: express.Router }, tracer, config)
}

function unpatch (express) {
  this.unwrap(express.application, METHODS)
  routerPlugin.unpatch.call(this, { prototype: express.Router })
}

module.exports = {
  name: 'express',
  versions: ['>=4'],
  patch,
  unpatch
}
