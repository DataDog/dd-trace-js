'use strict'

function createWrapRequest (tracer) {
  const scope = tracer.scope()

  return function wrapRequest (original) {
    return function requestWithTrace (request, callback) {
      return original.call(this, request, scope.bind(callback))
    }
  }
}

module.exports = [
  {
    name: 'limitd-client',
    versions: ['>=2.8'],
    patch (LimitdClient, tracer) {
      this.wrap(LimitdClient.prototype, '_directRequest', createWrapRequest(tracer))
      this.wrap(LimitdClient.prototype, '_retriedRequest', createWrapRequest(tracer))
    },
    unpatch (LimitdClient) {
      this.unwrap(LimitdClient.prototype, '_directRequest')
      this.unwrap(LimitdClient.prototype, '_retriedRequest')
    }
  }
]
