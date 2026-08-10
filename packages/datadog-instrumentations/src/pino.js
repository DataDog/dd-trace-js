'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const logSubmissionCh = channel('ci:log-submission:log')

/**
 * @param {string | symbol} asJsonSymbol
 * @param {Function} pino
 * @param {symbol} [hooksSymbol]
 */
function wrapPino (asJsonSymbol, pino, hooksSymbol) {
  /**
   * @param {unknown[]} args
   * @returns {unknown}
   */
  return function pinoWithTrace (...args) {
    const instance = pino.apply(this, args)
    const hooks = hooksSymbol === undefined ? undefined : instance[hooksSymbol]
    const streamWrite = hooks?.streamWrite
    const hasStreamWrite = typeof streamWrite === 'function'

    if (hooksSymbol !== undefined && hasStreamWrite && logSubmissionCh.hasSubscribers) {
      Object.defineProperty(instance, hooksSymbol, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { ...hooks, streamWrite: wrapStreamWrite(streamWrite) },
      })
    }

    Object.defineProperty(instance, asJsonSymbol, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapAsJson(instance[asJsonSymbol], !hasStreamWrite),
    })

    return instance
  }
}

/**
 * @param {Function} streamWrite
 * @returns {Function}
 */
function wrapStreamWrite (streamWrite) {
  /**
   * @param {string} line
   */
  return function streamWriteWithLogSubmission (line) {
    const message = streamWrite.apply(this, arguments)
    if (logSubmissionCh.hasSubscribers) {
      logSubmissionCh.publish({ source: 'pino', message })
    }
    return message
  }
}

/**
 * @param {Function} asJson
 * @param {boolean} submitLog
 * @returns {Function}
 */
function wrapAsJson (asJson, submitLog) {
  const jsonCh = channel('apm:pino:log:json')
  return function asJsonWithTrace (obj, msg, num, time) {
    obj = arguments[0] = obj || {}

    // Caller-provided `dd` wins -- skip the splice so a bespoke `dd` survives.
    let line
    if (!jsonCh.hasSubscribers || Object.hasOwn(obj, 'dd')) {
      line = asJson.apply(this, arguments)
    } else {
      const payload = { line: asJson.apply(this, arguments) }
      jsonCh.publish(payload)
      line = payload.line
    }

    if (submitLog && logSubmissionCh.hasSubscribers) {
      logSubmissionCh.publish({ source: 'pino', message: line })
    }

    return line
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

// Pino installs a symbol-keyed serialization method on each logger instance at runtime,
// which Orchestrion cannot replace across the supported Pino 2+ shapes.
addHook({ name: 'pino', versions: ['2 - 3', '4'], patchDefault: true }, (pino) => {
  const asJsonSym = (pino.symbols && pino.symbols.asJsonSym) || 'asJson'

  return shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, pino))
})

addHook({ name: 'pino', versions: ['>=5 <6.8.0'], patchDefault: true }, (pino) => {
  const asJsonSym = ((pino.default || pino)?.symbols.asJsonSym) || 'asJson'

  return shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, pino.default || pino))
})

addHook({ name: 'pino', versions: ['>=6.8.0'], patchDefault: false }, (pino) => {
  const asJsonSym = pino.symbols.asJsonSym
  const hooksSym = Number.parseInt(pino.version, 10) >= 9 ? pino.symbols.hooksSym : undefined

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, pino, hooksSym))
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
