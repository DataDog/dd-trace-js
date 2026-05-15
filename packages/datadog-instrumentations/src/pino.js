'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

/**
 * @param {string} symbol
 * @param {(original: Function) => Function} wrapper
 * @param {Function} pino
 */
function wrapPino (symbol, wrapper, pino) {
  /**
   * @param {unknown[]} args
   * @returns {unknown}
   */
  return function pinoWithTrace (...args) {
    const instance = pino.apply(this, args)

    Object.defineProperty(instance, symbol, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapper(instance[symbol]),
    })

    return instance
  }
}

function wrapAsJson (asJson) {
  // `apm:pino:log` is the legacy pre-serialisation hook. Subscribers receive
  // the message object and can mutate it; only fires when something is
  // listening so apps without a registered subscriber (the common case once
  // `PinoPlugin` moves to the JSON-line channel) pay zero allocation here.
  //
  // `apm:pino:log:json` is the fast log-injection path. Subscribers receive
  // the JSON line pino just produced and may rewrite it before it reaches the
  // destination stream; the line is a sync string, so the subscriber can
  // splice trace-correlation fields in without ever touching the caller-owned
  // message object.
  const messageCh = channel('apm:pino:log')
  const jsonCh = channel('apm:pino:log:json')
  return function asJsonWithTrace (obj, msg, num, time) {
    obj = arguments[0] = obj || {}

    // Caller-provided `dd` wins -- pin it before any subscriber on
    // `apm:pino:log` may add a virtual `dd` via a Proxy view.
    const callerHasDd = Object.hasOwn(obj, 'dd')

    if (messageCh.hasSubscribers) {
      const payload = { message: obj }
      messageCh.publish(payload)
      arguments[0] = payload.message
    }

    if (!jsonCh.hasSubscribers || callerHasDd) return asJson.apply(this, arguments)

    const payload = { line: asJson.apply(this, arguments) }
    jsonCh.publish(payload)
    return payload.line
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
  return function prettyFactoryWithTrace (...args) {
    const pretty = prettyFactory.apply(this, args)
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

  return shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, wrapAsJson, pino))
})

addHook({ name: 'pino', versions: ['>=5 <6.8.0'], patchDefault: true }, (pino) => {
  const asJsonSym = ((pino.default || pino)?.symbols.asJsonSym) || 'asJson'

  return shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, wrapAsJson, pino.default || pino))
})

addHook({ name: 'pino', versions: ['>=6.8.0'], patchDefault: false }, (pino) => {
  const asJsonSym = pino.symbols.asJsonSym

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, wrapAsJson, pino))
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
