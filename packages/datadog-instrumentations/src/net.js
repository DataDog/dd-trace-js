'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startICPCh = channel('apm:net:ipc:start')
const finishICPCh = channel('apm:net:ipc:finish')
const errorICPCh = channel('apm:net:ipc:error')

const startTCPCh = channel('apm:net:tcp:start')
const finishTCPCh = channel('apm:net:tcp:finish')
const errorTCPCh = channel('apm:net:tcp:error')

const connectionCh = channel(`apm:net:tcp:connection`)

addHook({ name: 'net' }, net => {
  require('dns')

  shimmer.wrap(net.Socket.prototype, 'connect', connect => function () {
    if (!startICPCh.hasSubscribers || !startTCPCh.hasSubscribers) {
      return connect.apply(this, arguments)
    }

    const options = getOptions(arguments)
    const lastIndex = arguments.length - 1
    const callback = arguments[lastIndex]

    if (!options) return connect.apply(this, arguments)

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    if (typeof callback === 'function') {
      arguments[lastIndex] = callbackResource.bind(callback)
    }

    const protocol = options.path ? 'ipc' : 'tcp'

    return asyncResource.runInAsyncScope(() => {
      if (protocol === 'ipc') {
        startICPCh.publish({ options })
        setupListeners(this, 'ipc', asyncResource)
      } else {
        startTCPCh.publish({ options })
        setupListeners(this, 'tcp', asyncResource)
      }

      const emit = this.emit
      this.emit = function (eventName) {
        switch (eventName) {
          case 'ready':
          case 'connect':
            return callbackResource.runInAsyncScope(() => {
              return emit.apply(this, arguments)
            })
          default:
            return emit.apply(this, arguments)
        }
      }

      try {
        return connect.apply(this, arguments)
      } catch (err) {
        protocol === 'ipc' ? errorICPCh.publish(err) : errorTCPCh.publish(err)

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
      if (isNaN(parseFloat(args[0]))) {
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

function setupListeners (socket, protocol, asyncResource) {
  const events = ['connect', 'error', 'close', 'timeout']

  const wrapListener = asyncResource.bind(function (error) {
    if (error) {
      protocol === 'ipc' ? errorICPCh.publish(error) : errorTCPCh.publish(error)
    }
    protocol === 'ipc' ? finishICPCh.publish(undefined) : finishTCPCh.publish(undefined)
  })

  const localListener = asyncResource.bind(function () {
    connectionCh.publish({ socket })
  })

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
