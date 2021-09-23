'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

// https://docs.apigee.com/api-platform/microgateway/3.1.x/develop-custom-plugins#eventhandlerfunctions
const listeners = [
  'onrequest',
  'ondata_request',
  'onend_request',
  'onclose_request',
  'onerror_request',
  'onresponse',
  'ondata_response',
  'onend_response',
  'onclose_response',
  'onerror_response'
]

function createWrapGateway (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapGateway (Gateway) {
    return function GatewayWithTrace (config) {
      const gateway = Gateway.apply(this, arguments)

      gateway.addPlugin = wrapAddPlugin(gateway.addPlugin)

      return gateway
    }
  }
}

function createWrapConfigProxyFactory (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapConfigProxyFactory (configProxyFactory) {
    return function configProxyFactoryWithTrace () {
      const configProxy = configProxyFactory.apply(this, arguments)

      return function configProxyWithTrace (req, res, next) {
        return web.instrument(tracer, config, req, res, 'microgateway.request', () => {
          web.beforeEnd(req, () => {
            res.proxy && web.enterRoute(req, res.proxy.base_path)
          })

          arguments[2] = wrapNext(req, next)

          return configProxy.apply(this, arguments)
        })
      }
    }
  }
}

function createWrapPluginsFactory (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapPluginsFactory (pluginsFactory) {
    return function pluginsFactoryWithTrace (plugins) {
      const pluginsMiddleware = pluginsFactory.apply(this, arguments)

      return function pluginsMiddlewareWithTrace (req, res, next) {
        arguments[2] = wrapNext(req, next)

        return pluginsMiddleware.apply(this, arguments)
      }
    }
  }
}

function wrapAddPlugin (addPlugin) {
  return function (name, plugin) {
    if (typeof plugin === 'function') {
      arguments[1] = wrapPluginInit(plugin)
    } else if (plugin && typeof plugin.init === 'function') {
      plugin.init = wrapPluginInit(plugin.init)
    }

    return addPlugin.apply(this, arguments)
  }
}

function wrapPluginInit (init) {
  return function initWithTrace (config, logging, stats) {
    const handler = init.apply(this, arguments)

    if (!handler._dd_patched) {
      wrapListeners(handler)
    }

    return handler
  }
}

function wrapNext (req, next) {
  return function nextWithTrace (err) {
    web.addError(req, err)

    return next.apply(this, arguments)
  }
}

function wrapListeners (handler) {
  for (const name of listeners) {
    const listener = handler[name]

    if (!listener) continue

    switch (listener.length) {
      case 3:
        handler[name] = function handlerWithTrace (req, res, next) {
          return web.reactivate(req, () => listener.apply(this, arguments))
        }
        break
      case 4:
        handler[name] = function handlerWithTrace (req, res, data, next) {
          return web.reactivate(req, () => listener.apply(this, arguments))
        }
        break
    }
  }
}

module.exports = [
  {
    name: 'microgateway-core',
    versions: ['>=2.1'],
    patch (Gateway, tracer, config) {
      return this.wrapExport(Gateway, createWrapGateway(tracer, config)(Gateway))
    },
    unpatch (Gateway) {
      this.unwrapExport(Gateway)
    }
  },
  {
    name: 'microgateway-core',
    versions: ['>=2.1'],
    file: 'lib/config-proxy-middleware.js',
    patch (configProxyFactory, tracer, config) {
      const wrapper = createWrapConfigProxyFactory(tracer, config)(configProxyFactory)
      return this.wrapExport(configProxyFactory, wrapper)
    },
    unpatch (configProxyFactory) {
      this.unwrapExport(configProxyFactory)
    }
  },
  {
    name: 'microgateway-core',
    versions: ['>=2.1'],
    file: 'lib/plugins-middleware.js',
    patch (pluginsFactory, tracer, config) {
      const wrapper = createWrapPluginsFactory(tracer, config)(pluginsFactory)
      return this.wrapExport(pluginsFactory, wrapper)
    },
    unpatch (pluginsFactory) {
      this.unwrapExport(pluginsFactory)
    }
  }
]
