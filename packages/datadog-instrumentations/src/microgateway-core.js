'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const handleChannel = channel('apm:microgateway-core:request:handle')
const routeChannel = channel('apm:microgateway-core:request:route')
const errorChannel = channel('apm:microgateway-core:request:error')

const name = 'microgateway-core'

// TODO Remove " <=3.0.0" when "volos-util-apigee" module is fixed
const versions = ['>=2.1 <=3.0.0']
const requestContexts = new WeakMap()

function wrapConfigProxyFactory (configProxyFactory) {
  return function () {
    const configProxy = configProxyFactory.apply(this, arguments)

    return function (req, res, next) {
      const ctx = { req, res }

      requestContexts.set(req, ctx)

      return handleChannel.runStores(ctx, configProxy, this, ...arguments)
    }
  }
}

function wrapPluginsFactory (pluginsFactory) {
  return function (plugins) {
    const pluginsMiddleware = pluginsFactory.apply(this, arguments)

    return function pluginsMiddlewareWithTrace (req, res, next) {
      arguments[2] = wrapNext(req, res, next)

      return pluginsMiddleware.apply(this, arguments)
    }
  }
}

function wrapNext (req, res, next) {
  return shimmer.wrapFunction(next, next => function nextWithTrace (err) {
    const ctx = requestContexts.get(req)

    if (err) {
      ctx.error = err
      errorChannel.publish(ctx)
    }

    if (res.proxy && res.proxy.base_path) {
      ctx.req = req
      ctx.res = res
      ctx.route = res.proxy.base_path
      return routeChannel.runStores(ctx, next, this, ...arguments)
    }
    return next.apply(this, arguments)
  })
}

addHook({ name, versions, file: 'lib/config-proxy-middleware.js' }, configProxyFactory => {
  return shimmer.wrapFunction(configProxyFactory, wrapConfigProxyFactory)
})

addHook({ name, versions, file: 'lib/plugins-middleware.js' }, pluginsFactory => {
  return shimmer.wrapFunction(pluginsFactory, wrapPluginsFactory)
})
