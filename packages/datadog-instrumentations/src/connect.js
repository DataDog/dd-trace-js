'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, publishError } = require('./helpers/instrument')

const enterChannel = channel('apm:connect:middleware:enter')
const exitChannel = channel('apm:connect:middleware:exit')
const errorChannel = channel('apm:connect:middleware:error')
const nextChannel = channel('apm:connect:middleware:next')
const finishChannel = channel('apm:connect:middleware:finish')
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

  return shimmer.wrapFunction(original, original => function (...args) {
    if (!enterChannel.hasSubscribers) return original.apply(this, args)

    const lastIndex = args.length - 1
    const name = original._name || original.name
    const req = args[args.length > 3 ? 1 : 0]
    const next = args[lastIndex]

    if (typeof next === 'function') {
      args[lastIndex] = wrapNext(req, next)
    }

    const route = layer.route

    enterChannel.publish({ name, req, route })

    try {
      return original.apply(this, args)
    } catch (error) {
      publishError(errorChannel, { req, error })
      nextChannel.publish({ req })
      finishChannel.publish({ req })

      throw error
    } finally {
      exitChannel.publish({ req })
    }
  })
}

function wrapNext (req, next) {
  // Mirror next's name/arity so wrapCallback skips its per-call identity rewrite.
  return shimmer.wrapCallback(next, original => function next (error) {
    if (error) {
      publishError(errorChannel, { req, error })
    }

    nextChannel.publish({ req })
    finishChannel.publish({ req })

    original.apply(this, arguments)
  })
}

addHook({ name: 'connect', versions: ['>=3.4.0'] }, (connect) => {
  return shimmer.wrapFunction(connect, connect => wrapConnect(connect))
})

addHook({ name: 'connect', versions: ['>=3 <3.4.0'], file: 'lib/connect.js' }, (connect) => {
  return shimmer.wrapFunction(connect, connect => wrapConnect(connect))
})

addHook({ name: 'connect', versions: ['2.2.2'], file: 'lib/connect.js' }, connect => {
  shimmer.wrap(connect.proto, 'use', wrapUse)
  shimmer.wrap(connect.proto, 'handle', wrapHandle)

  return connect
})
