'use strict'

const types = require('./types')
const { channel, addHook, AsyncResource } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startChannel = channel('apm:grpc:server:request:start')
const errorChannel = channel('apm:grpc:server:request:error')
const updateChannel = channel('apm:grpc:server:request:update')
const finishChannel = channel('apm:grpc:server:request:finish')

// https://github.com/grpc/grpc/blob/master/doc/statuscodes.md
const OK = 0
const CANCELLED = 1

function wrapHandler (func, name) {
  const isValid = (server, args) => {
    if (!startChannel.hasSubscribers) return false
    if (!server || !server.type) return false
    if (!args[0]) return false
    if (server.type !== 'unary' && !isEmitter(args[0])) return false
    if (server.type === 'unary' && typeof args[1] !== 'function') return false

    return true
  }

  return function (call, callback) {
    if (!isValid(this, arguments)) return func.apply(this, arguments)

    const metadata = call.metadata
    const type = types[this.type]
    const isStream = type !== 'unary'

    const parentResource = new AsyncResource('bound-anonymous-fn')
    const requestResource = new AsyncResource('bound-anonymous-fn')

    return requestResource.runInAsyncScope(() => {
      startChannel.publish({ name, metadata, type })

      // Finish the span if the call was cancelled.
      call.once('cancelled', requestResource.bind(() => {
        finishChannel.publish({ code: CANCELLED })
      }))

      if (isStream) {
        wrapStream(call, requestResource, parentResource)
      } else {
        arguments[1] = wrapCallback(callback, requestResource, parentResource)
      }

      shimmer.wrap(call, 'emit', emit => requestResource.bind(emit))

      return func.apply(this, arguments)
    })
  }
}

function wrapRegister (register) {
  return function (name, handler, serialize, deserialize, type) {
    if (typeof handler === 'function') {
      arguments[1] = wrapHandler(handler, name)
    }

    return register.apply(this, arguments)
  }
}

function wrapStream (call, requestResource) {
  if (call.call && call.call.sendStatus) {
    call.call.sendStatus = wrapSendStatus(call.call.sendStatus, requestResource)
  }

  shimmer.wrap(call, 'emit', emit => {
    return function (eventName, ...args) {
      switch (eventName) {
        case 'error':
          errorChannel.publish(args[0])
          finishChannel.publish({ code: args[0].code })

          break

          // Finish the span of the response only if it was successful.
          // Otherwise it'll be finished in the `error` listener.
        case 'finish':
          if (call.status) {
            updateChannel.publish(call.status)
          }

          if (!call.status || call.status.code === 0) {
            finishChannel.publish()
          }

          break
      }

      return emit.apply(this, arguments)
    }
  })
}

function wrapCallback (callback, requestResource, parentResource) {
  return function (err, value, trailer, flags) {
    requestResource.runInAsyncScope(() => {
      if (err instanceof Error) {
        errorChannel.publish(err)
        finishChannel.publish(err)
      } else {
        finishChannel.publish({ code: OK, trailer })
      }
    })

    if (callback) {
      return parentResource.runInAsyncScope(() => {
        return callback.apply(this, arguments)
      })
    }
  }
}

function wrapSendStatus (sendStatus, requestResource) {
  return function (status) {
    requestResource.runInAsyncScope(() => {
      updateChannel.publish(status)
    })

    return sendStatus.apply(this, arguments)
  }
}

function isEmitter (obj) {
  return typeof obj.emit === 'function' && typeof obj.once === 'function'
}

addHook({ name: 'grpc', versions: ['>=1.24.3'], file: 'src/server.js' }, server => {
  shimmer.wrap(server.Server.prototype, 'register', wrapRegister)

  return server
})

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'], file: 'build/src/server.js' }, server => {
  shimmer.wrap(server.Server.prototype, 'register', wrapRegister)

  return server
})
