'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapOn () {
  return function wrapOn (on) {
    return function onWithTrace (method, path, opts) {
      const index = typeof opts === 'function' ? 2 : 3
      const handler = arguments[index]
      const wrapper = function (req) {
        web.patch(req)
        web.enterRoute(req, path)

        return handler.apply(this, arguments)
      }

      if (typeof handler === 'function') {
        arguments[index] = wrapper
      }

      return on.apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'find-my-way',
    versions: ['>=1'],
    patch (Router, tracer, config) {
      this.wrap(Router.prototype, 'on', createWrapOn(tracer, config))
    },
    unpatch (Router) {
      this.unwrap(Router.prototype, 'on')
    }
  }
]
