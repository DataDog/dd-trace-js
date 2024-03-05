'use strict'

const types = require('./types')
const { channel, addHook } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const nodeMajor = parseInt(process.versions.node.split('.')[0])

const startChannel = channel('apm:grpc:server:request:start')
const asyncStartChannel = channel('apm:grpc:server:request:asyncStart')
const errorChannel = channel('apm:grpc:server:request:error')
const updateChannel = channel('apm:grpc:server:request:update')
const finishChannel = channel('apm:grpc:server:request:finish')
const emitChannel = channel('apm:grpc:server:request:emit')

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

    const ctx = { name, metadata, type }

    return startChannel.runStores(ctx, () => {
      try {
        const onCancel = () => {
          ctx.code = CANCELLED
          finishChannel.publish(ctx)
        }

        // Finish the span if the call was cancelled.
        call.once('cancelled', onCancel)

        if (isStream) {
          wrapStream(call, ctx, onCancel)
        } else {
          arguments[1] = wrapCallback(callback, call, ctx, onCancel)
        }

        shimmer.wrap(call, 'emit', emit => {
          return function () {
            return emitChannel.runStores(ctx, () => {
              return emit.apply(this, arguments)
            })
          }
        })

        return func.apply(this, arguments)
      } catch (e) {
        ctx.error = e
        errorChannel.publish(ctx)
      }
      // No end channel needed
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

function createWrapEmit (call, ctx, onCancel) {
  return function wrapEmit (emit) {
    return function (event, arg1) {
      switch (event) {
        case 'error':
          ctx.error = arg1
          errorChannel.publish(ctx)
          ctx.code = arg1.code
          finishChannel.publish(ctx)
          call.removeListener('cancelled', onCancel)
          break
        // Streams are always cancelled before `finish` since 1.10.0 so we have
        // to use `prefinish` instead to avoid cancellation false positives.
        case 'prefinish':
          if (call.status) {
            updateChannel.publish(call.status)
          }
          if (!call.status || call.status.code === 0) {
            finishChannel.publish(ctx)
          }
          call.removeListener('cancelled', onCancel)
          break
      }

      return emit.apply(this, arguments)
    }
  }
}

function wrapStream (call, ctx, onCancel) {
  if (call.call && call.call.sendStatus) {
    call.call.sendStatus = wrapSendStatus(call.call.sendStatus, ctx)
  }

  shimmer.wrap(call, 'emit', createWrapEmit(call, ctx, onCancel))
}

function wrapCallback (callback = () => {}, call, ctx, onCancel) {
  return function (err, value, trailer, flags) {
    if (err) {
      ctx.error = err
      errorChannel.publish(ctx)
    } else {
      ctx.code = OK
      ctx.trailer = trailer
    }

    finishChannel.publish(ctx)

    call.removeListener('cancelled', onCancel)

    return asyncStartChannel.runStores(ctx, () => {
      return callback.apply(this, arguments)
      // No async end channel needed
    })
  }
}

function wrapSendStatus (sendStatus, ctx) {
  return function (status) {
    ctx.status = status
    updateChannel.publish(ctx)

    return sendStatus.apply(this, arguments)
  }
}

function isEmitter (obj) {
  return typeof obj.emit === 'function' && typeof obj.once === 'function'
}

if (nodeMajor <= 14) {
  addHook({ name: 'grpc', versions: ['>=1.24.3'], file: 'src/server.js' }, server => {
    shimmer.wrap(server.Server.prototype, 'register', wrapRegister)

    return server
  })
}

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'], file: 'build/src/server.js' }, server => {
  shimmer.wrap(server.Server.prototype, 'register', wrapRegister)

  return server
})
