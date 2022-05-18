'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const enterChannel = channel('apm:connect:middleware:enter')
const errorChannel = channel('apm:connect:middleware:error')
const exitChannel = channel('apm:connect:middleware:exit')
const nextChannel = channel('apm:connect:middleware:next')
const handleChannel = channel('apm:connect:request:handle')

function wrapConnect (connect) {
  if (typeof connect !== 'function') return connect

  return function connectWithTrace () {
    const app = connect()

    if (!app) return app

    shimmer.wrap(app, 'use', wrapUse)
    shimmer.wrap(app, 'handle', wrapHandle)

    return app
  }
}

function wrapUse (use) {
  if (typeof use !== 'function') return use

  return function useWithTrace (route, fn) {
    const result = use.apply(this, arguments)

    if (!this || !Array.isArray(this.stack)) return result

    const index = this.stack.length - 1
    const layer = this.stack[index]

    if (layer && layer.handle) {
      this.stack[index].handle = wrapLayerHandle(layer)
    }

    return result
  }
}

function wrapHandle (handle) {
  return function handleWithTrace (req, res) {
    if (handleChannel.hasSubscribers) {
      handleChannel.publish({ req, res })
    }

    return handle.apply(this, arguments)
  }
}

function wrapLayerHandle (layer) {
  if (typeof layer.handle !== 'function') return layer.handle

  const original = layer.handle

  return shimmer.wrap(original, function () {
    if (!enterChannel.hasSubscribers) return original.apply(this, arguments)

    const lastIndex = arguments.length - 1
    const name = original._name || original.name
    const req = arguments[arguments.length > 3 ? 1 : 0]
    const next = arguments[lastIndex]

    if (typeof next === 'function') {
      arguments[lastIndex] = wrapNext(req, next)
    }

    const route = layer.route

    enterChannel.publish({ name, req, route })

    try {
      return original.apply(this, arguments)
    } catch (e) {
      errorChannel.publish(e)
      nextChannel.publish({ req })

      throw e
    } finally {
      exitChannel.publish({ req })
    }
  })
}

function wrapNext (req, next) {
  return function (error) {
    if (error) {
      errorChannel.publish(error)
    }

    nextChannel.publish({ req })

    next.apply(null, arguments)
  }
}

addHook({ name: 'connect', versions: ['>=3'] }, connect => {
  return shimmer.wrap(connect, wrapConnect(connect))
})

addHook({ name: 'connect', versions: ['2.2.2'] }, connect => {
  shimmer.wrap(connect.proto, 'use', wrapUse)
  shimmer.wrap(connect.proto, 'handle', wrapHandle)

  return connect
})
