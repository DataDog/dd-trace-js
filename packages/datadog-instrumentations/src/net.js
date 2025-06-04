'use strict'

const { errorMonitor } = require('events')

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startICPCh = channel('apm:net:ipc:start')
const finishICPCh = channel('apm:net:ipc:finish')
const errorICPCh = channel('apm:net:ipc:error')

const startTCPCh = channel('apm:net:tcp:start')
const finishTCPCh = channel('apm:net:tcp:finish')
const errorTCPCh = channel('apm:net:tcp:error')

const readyCh = channel('apm:net:tcp:ready')
const connectionCh = channel('apm:net:tcp:connection')

const names = ['net', 'node:net']

addHook({ name: names }, (net, version, name) => {
  // explicitly require dns so that net gets an instrumented instance
  // so that we don't miss the dns calls
  if (name === 'net') {
    require('dns')
  } else {
    require('node:dns')
  }

  shimmer.wrap(net.Socket.prototype, 'connect', connect => function () {
    if (!startICPCh.hasSubscribers || !startTCPCh.hasSubscribers) {
      return connect.apply(this, arguments)
    }

    const options = getOptions(arguments)
    const lastIndex = arguments.length - 1
    const callback = arguments[lastIndex]

    if (!options) return connect.apply(this, arguments)

    const protocol = options.path ? 'ipc' : 'tcp'
    const startCh = protocol === 'ipc' ? startICPCh : startTCPCh
    const finishCh = protocol === 'ipc' ? finishICPCh : finishTCPCh
    const errorCh = protocol === 'ipc' ? errorICPCh : errorTCPCh
    const ctx = { options }

    if (typeof callback === 'function') {
      arguments[lastIndex] = function (...args) {
        return finishCh.runStores(ctx, callback, this, ...args)
      }
    }

    return startCh.runStores(ctx, () => {
      setupListeners(this, protocol, ctx, finishCh, errorCh)

      const emit = this.emit
      this.emit = shimmer.wrapFunction(emit, emit => function (eventName) {
        switch (eventName) {
          case 'ready':
          case 'connect':
            return readyCh.runStores(ctx, () => {
              return emit.apply(this, arguments)
            })
          default:
            return emit.apply(this, arguments)
        }
      })

      try {
        return connect.apply(this, arguments)
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
          path: args[0]
        }
      }
    case 'number': // eslint-disable-line no-fallthrough
      return {
        port: args[0],
        host: typeof args[1] === 'string' ? args[1] : 'localhost'
      }
  }
}

function setupListeners (socket, protocol, ctx, finishCh, errorCh) {
  const events = ['connect', errorMonitor, 'close', 'timeout']

  const wrapListener = function (error) {
    if (error) {
      ctx.error = error
      errorCh.publish(ctx)
    }
    finishCh.runStores(ctx, () => {})
  }

  const localListener = function () {
    ctx.socket = socket
    connectionCh.publish(ctx)
  }

  const cleanupListener = function () {
    socket.removeListener('connect', localListener)
    events.forEach(event => {
      socket.removeListener(event, wrapListener)
      socket.removeListener(event, cleanupListener)
    })
  }

  if (protocol === 'tcp') {
    socket.once('connect', localListener)
  }

  events.forEach(event => {
    socket.once(event, wrapListener)
    socket.once(event, cleanupListener)
  })
}
