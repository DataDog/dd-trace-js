'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

// Channel for transport injection (similar to Winston/Bunyan)
const transportConfigCh = channel('ci:log-submission:pino:get-transport-config')

function wrapPino (symbol, wrapper, pino) {
  return function pinoWithTrace () {
    // Get HTTP transport from plugin if available
    let httpTransport = null
    if (transportConfigCh.hasSubscribers) {
      const configPayload = {}
      transportConfigCh.publish(configPayload)
      httpTransport = configPayload.transport
    }

    // STEP 1: Create logger with user's original config (unchanged)
    const instance = pino.apply(this, arguments)

    // Apply trace injection wrapper
    Object.defineProperty(instance, symbol, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapper(instance[symbol])
    })

    // STEP 2: If HTTP transport available, combine with user's destination
    if (httpTransport) {
      try {
        // Get Pino's internal stream symbol
        const streamSym = pino.symbols && pino.symbols.streamSym
        if (!streamSym) {
          // Symbol not available, skip multistream
          return instance
        }

        // Get the destination stream that Pino created
        const originalDestination = instance[streamSym]

        if (originalDestination) {
          // STEP 3: Create multistream combining both destinations
          const multistream = pino.multistream || require('pino').multistream
          const combinedDestination = multistream([
            { stream: originalDestination },
            { stream: httpTransport }
          ])

          // STEP 4: Replace the stream in the logger
          instance[streamSym] = combinedDestination

          // Mark logger as having HTTP transport injected
          Object.defineProperty(instance, Symbol.for('dd-trace-pino-transport-injected'), {
            value: true,
            configurable: true
          })
        } else {
          // No original destination, just use HTTP transport
          instance[streamSym] = httpTransport

          Object.defineProperty(instance, Symbol.for('dd-trace-pino-transport-injected'), {
            value: true,
            configurable: true
          })
        }
      } catch (err) {
        // Silently fail - don't crash user's application
        // Logger will work normally without HTTP transport
      }
    }

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

addHook({ name: 'pino', versions: ['>=6.8.0'], patchDefault: false }, (pino, _1, _2, isIitm) => {
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
