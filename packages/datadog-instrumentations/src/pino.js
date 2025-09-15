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

    const payload = { message: obj }
    ch.publish(payload)
    arguments[0] = payload.message

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

    const payload = { message: obj }
    ch.publish(payload)

    return payload.message
  }
}

function wrapPrettifyObject (prettifyObject) {
  const ch = channel('apm:pino:log')
  return function prettifyObjectWithTrace (input) {
    const payload = { message: input.input }
    ch.publish(payload)
    input.input = payload.message
    return prettifyObject.apply(this, arguments)
  }
}

function wrapPrettyFactory (prettyFactory) {
  const ch = channel('apm:pino:log')
  return function prettyFactoryWithTrace () {
    const pretty = prettyFactory.apply(this, arguments)
    return function prettyWithTrace (obj) {
      const payload = { message: obj }
      ch.publish(payload)
      arguments[0] = payload.message
      return pretty.apply(this, arguments)
    }
  }
}

addHook({ name: 'pino', versions: ['2 - 3', '4'] }, (pino, _1, _2, isIitm) => {
  if (!pino.default && isIitm) return
  const asJsonSym = (pino.symbols && pino.symbols.asJsonSym) || 'asJson'

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, wrapAsJson, isIitm ? pino.default : pino))

  return wrapped
})

addHook({ name: 'pino', versions: ['>=5 <5.14.0'] }, (pino, _1, _2, isIitm) => {
  const asJsonSym = ((pino.default || pino)?.symbols.asJsonSym) || 'asJson'

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, wrapAsJson, isIitm ? pino.default : pino))

  return wrapped
})

addHook({ name: 'pino', versions: ['>=5.14.0 <6.8.0'] }, (pino) => {
  const mixinSym = (pino.default || pino).symbols.mixinSym

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(mixinSym, wrapMixin, pino.default || pino))

  return wrapped
})

addHook({ name: 'pino', versions: ['>=6.8.0'] }, (pino, _1, _2, isIitm) => {
  if (isIitm && !pino.default) return
  const mixinSym = pino.symbols.mixinSym

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(mixinSym, wrapMixin, isIitm ? pino.default : pino))
  wrapped.pino = wrapped
  wrapped.default = wrapped

  return wrapped
})

addHook({ name: 'pino-pretty', file: 'lib/utils.js', versions: ['>=3'] }, utils => {
  shimmer.wrap(utils, 'prettifyObject', wrapPrettifyObject)
  return utils
})

addHook({ name: 'pino-pretty', versions: ['1 - 2'] }, prettyFactory => {
  return shimmer.wrapFunction(prettyFactory, wrapPrettyFactory)
})
