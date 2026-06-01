'use strict'

const { errorMonitor } = require('events')

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const startICPCh = channel('apm:net:ipc:start')
const finishICPCh = channel('apm:net:ipc:finish')
const errorICPCh = channel('apm:net:ipc:error')

const startTCPCh = channel('apm:net:tcp:start')
const finishTCPCh = channel('apm:net:tcp:finish')
const errorTCPCh = channel('apm:net:tcp:error')

const readyCh = channel('apm:net:tcp:ready')
const connectionCh = channel('apm:net:tcp:connection')

addHook({ name: 'net' }, (net) => {
  // explicitly require dns so that net gets an instrumented instance
  // so that we don't miss the dns calls
  require('node:dns')

  shimmer.wrap(net.Socket.prototype, 'connect', connect => function (...args) {
    if (!startICPCh.hasSubscribers || !startTCPCh.hasSubscribers) {
      return connect.apply(this, args)
    }

    const options = getOptions(args)
    const lastIndex = args.length - 1
    const callback = args[lastIndex]

    if (!options) return connect.apply(this, args)

    const protocol = options.path ? 'ipc' : 'tcp'
    const startCh = protocol === 'ipc' ? startICPCh : startTCPCh
    const finishCh = protocol === 'ipc' ? finishICPCh : finishTCPCh
    const errorCh = protocol === 'ipc' ? errorICPCh : errorTCPCh
    const ctx = { options }

    if (typeof callback === 'function') {
      args[lastIndex] = function (...args) {
        return finishCh.runStores(ctx, callback, this, ...args)
      }
    }

    return startCh.runStores(ctx, () => {
      setupListeners(this, protocol, ctx, finishCh, errorCh)

      const emit = this.emit
      let pendingReadyEvents = 2
      // Named `emit`/arity-1 mirrors the socket method so the per-socket wrap
      // skips its name/length rewrite.
      this.emit = shimmer.wrapFunction(emit, originalEmit => function emit (eventName) {
        switch (eventName) {
          case 'ready':
          case 'connect':
            if (--pendingReadyEvents === 0) this.emit = originalEmit
            return readyCh.runStores(ctx, () => {
              return Reflect.apply(originalEmit, this, arguments)
            })
          case 'error':
          case 'close':
            this.emit = originalEmit
            return Reflect.apply(originalEmit, this, arguments)
          default:
            return Reflect.apply(originalEmit, this, arguments)
        }
      })

      try {
        return connect.apply(this, args)
      } catch (err) {
        errorCh.publish(err)

        throw err
      }
    })
  })

  return net
})

function getOptions (args) {
  if (!args[0]) return

  switch (typeof args[0]) {
    case 'object':
      if (Array.isArray(args[0])) return getOptions(args[0])
      return args[0]
    case 'string':
      if (Number.isNaN(Number.parseFloat(args[0]))) {
        return {
          path: args[0],
        }
      }
    case 'number': // eslint-disable-line no-fallthrough
      return {
        port: args[0],
        host: typeof args[1] === 'string' ? args[1] : 'localhost',
      }
  }
}

function setupListeners (socket, protocol, ctx, finishCh, errorCh) {
  const events = [errorMonitor, 'close', 'timeout']

  const wrapListener = function (error) {
    if (error) {
      ctx.error = error
      errorCh.publish(ctx)
    }
    finishCh.runStores(ctx, () => {})
    cleanupOtherListeners()
  }

  const localListener = function (error) {
    ctx.socket = socket
    connectionCh.publish(ctx)
    if (error) {
      ctx.error = error
      errorCh.publish(ctx)
    }
    finishCh.runStores(ctx, () => {})
    cleanupOtherListeners()
  }

  const cleanupOtherListeners = function () {
    socket.removeListener('connect', localListener)
    for (const event of events) {
      socket.removeListener(event, wrapListener)
    }
  }

  // TODO: Identify why the connect listener should remove the other listeners.
  if (protocol === 'tcp') {
    socket.once('connect', localListener)
  } else {
    events.push('connect')
  }

  for (const event of events) {
    socket.once(event, wrapListener)
  }
}
