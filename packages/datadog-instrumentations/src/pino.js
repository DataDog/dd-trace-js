'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const PINO_JSON_CHANNEL = 'apm:pino:json'

function wrapPino (symbol, wrapper, pino) {
  return function pinoWithTrace () {
    const instance = pino.apply(this, arguments)

    // Trace injection wrapper (mixinSym for >=5.14, asJsonSym for <5.14)
    Object.defineProperty(instance, symbol, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapper(instance[symbol]),
    })

    // For >=5.14.0: mixin only sees partial data (no pid, hostname, time, msg).
    // Additionally wrap asJson to capture the complete JSON record for log forwarding.
    const asJsonSym = pino.symbols && pino.symbols.asJsonSym
    if (asJsonSym && symbol !== asJsonSym && typeof instance[asJsonSym] === 'function') {
      Object.defineProperty(instance, asJsonSym, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: wrapAsJsonForCapture(instance[asJsonSym]),
      })
    }

    return instance
  }
}

function wrapAsJson (asJson) {
  const ch = channel('apm:pino:log')
  const captureCh = channel(PINO_JSON_CHANNEL)
  return function asJsonWithTrace (obj, msg, num, time) {
    obj = arguments[0] = obj || {}

    const payload = { message: obj }
    ch.publish(payload)
    arguments[0] = payload.message

    const jsonLine = asJson.apply(this, arguments)
    if (captureCh.hasSubscribers) {
      captureCh.publish({ json: jsonLine, holder: payload.holder })
    }
    return jsonLine
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

/**
 * Wraps asJson to capture the complete serialized JSON line for log forwarding.
 * Publishes to 'apm:pino:json' with { json: string }.
 * Used for Pino >=5.14.0 where mixinSym is the primary trace-injection hook
 * and only provides partial mixin data (no pid, hostname, time, msg).
 * @param {Function} asJson
 * @returns {Function}
 */
function wrapAsJsonForCapture (asJson) {
  const captureCh = channel(PINO_JSON_CHANNEL)
  return function asJsonWithCapture (obj, msg, num, time) {
    const jsonLine = asJson.apply(this, arguments)
    if (captureCh.hasSubscribers) {
      captureCh.publish({ json: jsonLine })
    }
    return jsonLine
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

addHook({ name: 'pino', versions: ['2 - 3', '4'], patchDefault: true }, (pino) => {
  const asJsonSym = (pino.symbols && pino.symbols.asJsonSym) || 'asJson'

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, wrapAsJson, pino))

  return wrapped
})

addHook({ name: 'pino', versions: ['>=5 <5.14.0'], patchDefault: true }, (pino) => {
  const asJsonSym = ((pino.default || pino)?.symbols.asJsonSym) || 'asJson'

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, wrapAsJson, pino))

  return wrapped
})

addHook({ name: 'pino', versions: ['>=5.14.0 <6.8.0'] }, (pino) => {
  const mixinSym = (pino.default || pino).symbols.mixinSym

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(mixinSym, wrapMixin, pino.default || pino))

  return wrapped
})

addHook({ name: 'pino', versions: ['>=6.8.0'], patchDefault: false }, (pino) => {
  const mixinSym = pino.symbols.mixinSym

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(mixinSym, wrapMixin, pino))
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

module.exports = {}
