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

function createWrapExecute (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const req = this.raw.req
      const res = this.raw.res

      let returnValue

      web.instrument(tracer, config, req, res, 'hapi.request', () => {
        returnValue = execute.apply(this, arguments)

        web.beforeEnd(req, () => {
          web.enterRoute(req, this.route.path)
        })
      })

      return returnValue
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
    versions: ['8.5 - 17.0'],
    file: 'lib/request.js',
    patch (Generator, tracer, config) {
      this.wrap(Generator.prototype, 'request', createWrapGenerate(tracer, config))
    },
    unpatch (Generator) {
      this.unwrap(Generator.prototype, 'request')
    }
  },
  {
    name: 'hapi',
    versions: ['2 - 8.4'],
    file: 'lib/request.js',
    patch (Request, tracer, config) {
      this.wrap(Request.prototype, '_execute', createWrapExecute(tracer, config))
    },
    unpatch (Request) {
      this.unwrap(Request.prototype, '_execute')
    }
  }
]
