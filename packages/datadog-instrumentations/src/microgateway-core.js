'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')

const handleChannel = channel('apm:microgateway-core:request:handle')
const routeChannel = channel('apm:microgateway-core:request:route')
const errorChannel = channel('apm:microgateway-core:request:error')

const name = 'microgateway-core'
const versions = ['>=2.1']
const requestResources = new WeakMap()

function wrapConfigProxyFactory (configProxyFactory) {
  return function () {
    const configProxy = configProxyFactory.apply(this, arguments)

    return function (req, res, next) {
      const requestResource = new AsyncResource('bound-anonymous-fn')

      requestResources.set(req, requestResource)

      handleChannel.publish({ req, res })

      return configProxy.apply(this, arguments)
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
  return function nextWithTrace (err) {
    const requestResource = requestResources.get(req)

    requestResource.runInAsyncScope(() => {
      if (err) {
        errorChannel.publish(err)
      }

      if (res.proxy && res.proxy.base_path) {
        routeChannel.publish({ req, res, route: res.proxy.base_path })
      }
    })

    return next.apply(this, arguments)
  }
}

addHook({ name, versions, file: 'lib/config-proxy-middleware.js' }, configProxyFactory => {
  return shimmer.wrap(configProxyFactory, wrapConfigProxyFactory(configProxyFactory))
})

addHook({ name, versions, file: 'lib/plugins-middleware.js' }, pluginsFactory => {
  return shimmer.wrap(pluginsFactory, wrapPluginsFactory(pluginsFactory))
})
