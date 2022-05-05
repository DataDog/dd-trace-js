'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const routeChannel = channel('apm:find-my-way:request:route')

function wrapOn (on) {
  return function onWithTrace (method, path, opts) {
    const index = typeof opts === 'function' ? 2 : 3
    const handler = arguments[index]
    const wrapper = function (req) {
      routeChannel.publish({ req, route: path })

      return handler.apply(this, arguments)
    }

    if (typeof handler === 'function') {
      arguments[index] = wrapper
    }

    return on.apply(this, arguments)
  }
}

addHook({ name: 'find-my-way', versions: ['>=1'] }, Router => {
  shimmer.wrap(Router.prototype, 'on', wrapOn)

  return Router
})
