'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function wrapPino (symbol, wrapper, pino) {
  return function pinoWithTrace () {
    const instance = pino.apply(this, arguments)

    Object.defineProperty(instance, symbol, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapper(instance[symbol])
    })

    return instance
  }
}

function wrapAsJson (asJson) {
  const ch = channel('apm:pino:log')
  return function asJsonWithTrace (obj, msg, num, time) {
    obj = arguments[0] = obj || {}

    const payload = { logMessage: obj, receiver: null }
    ch.publish(payload)
    if (payload.receiver) {
      arguments[0] = payload.receiver
    }

    return asJson.apply(this, arguments)
  }
}

function wrapMixin (mixin) {
  const ch = channel('apm:pino:log')
  return function mixinWithTrace () {
    let obj = {}

    if (mixin) {
      obj = mixin.apply(this, arguments)
    }

    ch.publish({ logMessage: obj })

    return obj
  }
}

function wrapPrettifyObject (prettifyObject) {
  const ch = channel('apm:pino:log')
  return function prettifyObjectWithTrace (input) {
    ch.publish({ logMessage: input.input })
    return prettifyObject.apply(this, arguments)
  }
}

function wrapPrettyFactory (prettyFactory) {
  const ch = channel('apm:pino:log')
  return function prettyFactoryWithTrace () {
    const pretty = prettyFactory.apply(this, arguments)
    return function prettyWithTrace (obj) {
      ch.publish({ logMessage: obj })
      return pretty.apply(this, arguments)
    }
  }
}

addHook({ name: 'pino', versions: ['2 - 3', '4', '>=5 <5.14.0'] }, pino => {
  const asJsonSym = (pino.symbols && pino.symbols.asJsonSym) || 'asJson'

  return shimmer.wrap(pino, wrapPino(asJsonSym, wrapAsJson, pino))
})

addHook({ name: 'pino', versions: ['>=5.14.0 <6.8.0'] }, pino => {
  const mixinSym = pino.symbols.mixinSym

  return shimmer.wrap(pino, wrapPino(mixinSym, wrapMixin, pino))
})

addHook({ name: 'pino', versions: ['>=6.8.0'] }, pino => {
  const mixinSym = pino.symbols.mixinSym

  const wrapped = shimmer.wrap(pino, wrapPino(mixinSym, wrapMixin, pino))
  wrapped.pino = wrapped
  wrapped.default = wrapped

  return wrapped
})

addHook({ name: 'pino-pretty', file: 'lib/utils.js', versions: ['>=3'] }, utils => {
  shimmer.wrap(utils, 'prettifyObject', wrapPrettifyObject)
  return utils
})

addHook({ name: 'pino-pretty', versions: ['1 - 2'] }, prettyFactory => {
  return shimmer.wrap(prettyFactory, wrapPrettyFactory(prettyFactory))
})
