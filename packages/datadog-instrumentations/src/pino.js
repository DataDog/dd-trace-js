'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const jsonCh = channel('apm:pino:log:json')
const logSubmissionCh = channel('ci:log-submission:log')
const legacyLogMethods = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']

/**
 * @param {string | symbol} asJsonSymbol
 * @param {string | symbol} writeSymbol
 * @param {Function} pino
 * @param {symbol} [hooksSymbol]
 */
function wrapPino (asJsonSymbol, writeSymbol, pino, hooksSymbol) {
  /**
   * @param {unknown[]} args
   * @returns {unknown}
   */
  return function pinoWithTrace (...args) {
    const instance = pino.apply(this, args)
    return wrapPinoInstance(instance, asJsonSymbol, writeSymbol, hooksSymbol)
  }
}

/**
 * @param {object} instance
 * @param {string | symbol} asJsonSymbol
 * @param {string | symbol} writeSymbol
 * @param {symbol} [hooksSymbol]
 * @returns {object}
 */
function wrapPinoInstance (instance, asJsonSymbol, writeSymbol, hooksSymbol) {
  const hooks = hooksSymbol === undefined ? undefined : instance[hooksSymbol]
  const streamWrite = hooks?.streamWrite
  const hasStreamWrite = typeof streamWrite === 'function'
  const submitLogs = logSubmissionCh.hasSubscribers
  const messages = submitLogs ? [] : undefined

  if (hooksSymbol !== undefined && hasStreamWrite && submitLogs) {
    Object.defineProperty(instance, hooksSymbol, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { ...hooks, streamWrite: wrapStreamWrite(streamWrite, messages) },
    })
  }

  Object.defineProperty(instance, asJsonSymbol, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrapAsJson(instance[asJsonSymbol], hasStreamWrite ? undefined : messages),
  })

  if (messages !== undefined && typeof instance[writeSymbol] === 'function') {
    Object.defineProperty(instance, writeSymbol, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapWrite(instance[writeSymbol], messages),
    })
  } else if (messages !== undefined) {
    wrapLegacyLogMethods(instance, messages)
    wrapLegacyLevel(instance, messages)
  }

  const child = instance.child
  Object.defineProperty(instance, 'child', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function childWithTrace () {
      const parentAsJson = this[asJsonSymbol]
      const childInstance = child.apply(this, arguments)
      return childInstance[asJsonSymbol] === parentAsJson
        ? childInstance
        : wrapPinoInstance(childInstance, asJsonSymbol, writeSymbol, hooksSymbol)
    },
  })

  return instance
}

/**
 * @param {object} instance
 * @param {(string | undefined)[]} messages
 * @returns {void}
 */
function wrapLegacyLogMethods (instance, messages) {
  const activeMethodCount = legacyLogMethods.indexOf(instance.level) + 1
  for (let index = 0; index < activeMethodCount; index++) {
    const methodName = legacyLogMethods[index]
    Object.defineProperty(instance, methodName, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapWrite(instance[methodName], messages),
    })
  }
}

/**
 * @param {object} instance
 * @param {(string | undefined)[]} messages
 * @returns {void}
 */
function wrapLegacyLevel (instance, messages) {
  const levelDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(instance), 'level')
  Object.defineProperty(instance, 'level', {
    configurable: true,
    enumerable: levelDescriptor.enumerable,
    get: levelDescriptor.get,
    set: function levelWithLogSubmission (level) {
      for (const methodName of legacyLogMethods) {
        delete this[methodName]
      }
      levelDescriptor.set.call(this, level)
      wrapLegacyLogMethods(this, messages)
    },
  })
}

/**
 * @param {Function} streamWrite
 * @param {(string | undefined)[]} messages
 * @returns {Function}
 */
function wrapStreamWrite (streamWrite, messages) {
  /**
   * @param {string} line
   */
  return function streamWriteWithLogSubmission (line) {
    const message = streamWrite.apply(this, arguments)
    try {
      const parsedMessage = JSON.parse(message)
      messages[messages.length - 1] = parsedMessage !== null &&
        typeof parsedMessage === 'object' &&
        !Array.isArray(parsedMessage)
        ? message
        : undefined
    } catch {
      messages[messages.length - 1] = undefined
    }
    return message
  }
}

/**
 * @param {Function} asJson
 * @param {(string | undefined)[] | undefined} messages
 * @returns {Function}
 */
function wrapAsJson (asJson, messages) {
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

    if (messages !== undefined) {
      messages[messages.length - 1] = line
    }

    return line
  }
}

/**
 * @param {Function} write
 * @param {(string | undefined)[]} messages
 * @returns {Function}
 */
function wrapWrite (write, messages) {
  return function writeWithLogSubmission () {
    const messageIndex = messages.length
    messages.push(undefined)
    let succeeded = false

    try {
      const result = write.apply(this, arguments)
      succeeded = true
      return result
    } finally {
      const message = messages[messageIndex]
      messages.length = messageIndex
      if (succeeded && message !== undefined && jsonCh.hasSubscribers && logSubmissionCh.hasSubscribers) {
        logSubmissionCh.publish({ source: 'pino', message })
      }
    }
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

  return shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, 'write', pino))
})

addHook({ name: 'pino', versions: ['>=5 <6.8.0'], patchDefault: true }, (pino) => {
  const exportedPino = pino.default || pino
  const asJsonSym = exportedPino.symbols.asJsonSym
  const writeSym = exportedPino.symbols.writeSym

  return shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, writeSym, exportedPino))
})

addHook({ name: 'pino', versions: ['>=6.8.0'], patchDefault: false }, (pino) => {
  const asJsonSym = pino.symbols.asJsonSym
  const hooksSym = Number.parseInt(pino.version, 10) >= 9 ? pino.symbols.hooksSym : undefined
  const writeSym = pino.symbols.writeSym

  const wrapped = shimmer.wrapFunction(pino, pino => wrapPino(asJsonSym, writeSym, pino, hooksSym))
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
