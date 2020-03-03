'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapConfigProxyFactory (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapConfigProxyFactory (configProxyFactory) {
    const configProxyFactoryWithTrace = function () {
      const configProxy = configProxyFactory.apply(this, arguments)

      return function configProxyWithTrace (req, res, next) {
        return web.instrument(tracer, config, req, res, 'microgateway.request', () => {
          web.beforeEnd(req, () => {
            res.proxy && web.enterRoute(req, res.proxy.base_path)
          })

          return configProxy.call(this, req, res, wrapNext(req, next))
        })
      }
    }

    configProxyFactoryWithTrace._dd_original = configProxyFactory

    return configProxyFactoryWithTrace
  }
}

function createWrapPluginsFactory (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapPluginsFactory (pluginsFactory) {
    const pluginsFactoryWithTrace = function () {
      const pluginsMiddleware = pluginsFactory.apply(this, arguments)

      return function pluginsMiddlewareWithTrace (req, res, next) {
        return pluginsMiddleware.call(this, req, res, wrapNext(req, next))
      }
    }

    pluginsFactoryWithTrace._dd_original = pluginsFactory

    return pluginsFactoryWithTrace
  }
}

function wrapNext (req, next) {
  return function (err) {
    web.addError(req, err)

    return next.apply(this, arguments)
  }
}

module.exports = [
  {
    name: 'microgateway-core',
    versions: ['>=2.1'],
    file: 'lib/config-proxy-middleware.js',
    patch (configProxyFactory, tracer, config) {
      return createWrapConfigProxyFactory(tracer, config)(configProxyFactory)
    },
    unpatch (configProxyFactory) {
      return configProxyFactory._dd_original
    }
  },
  {
    name: 'microgateway-core',
    versions: ['>=2.1'],
    file: 'lib/plugins-middleware.js',
    patch (pluginsFactory, tracer, config) {
      return createWrapPluginsFactory(tracer, config)(pluginsFactory)
    },
    unpatch (pluginsFactory) {
      return pluginsFactory._dd_original
    }
  }
]
