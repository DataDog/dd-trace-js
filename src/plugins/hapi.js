'use strict'

const web = require('./util/web')

function createWrapGenerate (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapGenerate (generate) {
    return function generateWithTrace (server, req, res, options) {
      let request

      web.instrument(tracer, config, req, res, 'hapi.request', () => {
        request = generate.apply(this, arguments)

        web.beforeEnd(req, () => {
          web.enterRoute(req, request.route.path)
        })
      })

      return request
    }
  }
}

module.exports = [
  {
    name: 'hapi',
    versions: ['^17.1'],
    file: 'lib/request.js',
    patch (Request, tracer, config) {
      this.wrap(Request, 'generate', createWrapGenerate(tracer, config))
    },
    unpatch (Request) {
      this.unwrap(Request, 'generate')
    }
  },
  {
    name: 'hapi',
    versions: ['<17.1'],
    file: 'lib/request.js',
    patch (Generator, tracer, config) {
      this.wrap(Generator.prototype, 'request', createWrapGenerate(tracer, config))
    },
    unpatch (Generator) {
      this.unwrap(Generator.prototype, 'request')
    }
  }
]
