'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const routerPlugin = require('../../datadog-plugin-router/src')

function createWrapHandle (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapHandle (handle) {
    return function handleWithTrace (req, res) {
      web.instrument(tracer, config, req, res, 'express.request')

      return handle.apply(this, arguments)
    }
  }
}

function patch (express, tracer, config) {
  this.wrap(express.application, 'handle', createWrapHandle(tracer, config))
  routerPlugin.patch.call(this, { prototype: express.Router }, tracer, config)
}

function unpatch (express) {
  this.unwrap(express.application, 'handle')
  routerPlugin.unpatch.call(this, { prototype: express.Router })
}

module.exports = {
  name: 'express',
  versions: ['>=4'],
  patch,
  unpatch
}
