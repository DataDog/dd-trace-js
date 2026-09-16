'use strict'

const nodeConsole = require('node:console')

const { Console } = nodeConsole
const nativeStderrDescriptor = Object.getOwnPropertyDescriptor(nodeConsole, '_stderr')
const nodeConsoleKeys = Reflect.ownKeys(Console.prototype)
const nodeConsoleWrite = nodeConsoleKeys.find(key => {
  return typeof key === 'symbol' && key.description === 'kWriteToConsole'
})

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const configureCh = channel('ci:log-submission:console:configure')
const logSubmissionCh = channel('ci:log-submission:console')
// Keep routine test output local while submitting diagnostics that can explain failures.
const methods = ['error', 'warn']
const methodSet = new Set(methods)
const nodeConsoleMethods = new Map(methods.map(method => {
  return [method, Object.getOwnPropertyDescriptor(Console.prototype, method)?.value]
}))
const disabledStreams = new WeakSet()
/** @type {WeakMap<object, symbol | false>} */
const nodeConsoleGroupIndentKeys = new WeakMap()
const nodeConsoleWriteOwners = new WeakSet()
const wrappedTargets = new WeakSet()

/** @typedef {{ dd: object }} LogHolder */
/** @typedef {{ logHolder?: LogHolder, method: string, message: string, writeId: number }} ConsoleRecord */
/**
 * @typedef {{
 *   captureLogHolder?: () => LogHolder | undefined,
 *   method: string,
 *   nodeConsole: boolean,
 *   observedRecords: ConsoleRecord[],
 *   ownRecords: ConsoleRecord[],
 *   records: ConsoleRecord[]
 * }} ConsoleCapture
 */

/** @type {ConsoleCapture | undefined} */
let activeCapture
let activeWriteId = 0
let expectedWrite
/** @type {(() => LogHolder | undefined) | undefined} */
let getLogHolder
/** @type {(() => boolean) | undefined} */
let isLogSubmissionAllowed
let isPublishing = false
let nextWriteId = 0

/** @typedef {{ write: (buffer: unknown, method: string, message: string) => unknown }} JestBufferedConsole */
/** @typedef {{ prototype: { _logError?: Function } }} JestCustomConsole */

/**
 * @param {string} method
 * @param {string} message
 * @param {number} writeId
 * @param {(() => LogHolder | undefined) | undefined} captureLogHolder
 * @returns {ConsoleRecord}
 */
function createRecord (method, message, writeId, captureLogHolder) {
  const record = { method, message, writeId }
  captureLogHolder ||= getLogHolder
  if (captureLogHolder) {
    let logHolder
    try {
      logHolder = captureLogHolder()
    } catch {}
    // Preserve the absence of correlation as well, so a later publish does
    // not accidentally pick up a different active span.
    record.logHolder = logHolder
  }
  return record
}

/**
 * @param {(() => boolean) | undefined} captureAllowed
 */
function shouldCaptureLogs (captureAllowed) {
  if (isPublishing || !logSubmissionCh.hasSubscribers) return false

  captureAllowed ||= isLogSubmissionAllowed
  if (!captureAllowed) return true
  try {
    return captureAllowed() !== false
  } catch {
    return false
  }
}

/**
 * @param {object | Function | undefined} target
 * @param {string} property
 * @returns {ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>}
 */
function getPropertyDescriptor (target, property) {
  let descriptor
  try {
    let owner = target
    let owners
    while (owner && !owners?.has(owner)) {
      descriptor = Object.getOwnPropertyDescriptor(owner, property)
      if (descriptor) break
      owners ||= new Set()
      owners.add(owner)
      owner = Object.getPrototypeOf(owner)
    }
  } catch {}
  return descriptor
}

/**
 * @param {ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>} actual
 * @param {ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>} expected
 */
function descriptorsMatch (actual, expected) {
  if (!actual || !expected) return actual === expected
  if (actual.configurable !== expected.configurable || actual.enumerable !== expected.enumerable) return false
  if (Object.hasOwn(expected, 'value')) {
    return Object.hasOwn(actual, 'value') && actual.value === expected.value && actual.writable === expected.writable
  }
  return !Object.hasOwn(actual, 'value') && actual.get === expected.get && actual.set === expected.set
}

/**
 * @param {Record<string, unknown>} stream
 * @param {ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>} writeDescriptor
 * @param {Function} [expectedWrite]
 */
function restoreStreamWrite (stream, writeDescriptor, expectedWrite) {
  try {
    if (expectedWrite && Object.getOwnPropertyDescriptor(stream, 'write')?.value !== expectedWrite) return true
    if (writeDescriptor) {
      Object.defineProperty(stream, 'write', writeDescriptor)
    } else {
      delete stream.write
    }
    return descriptorsMatch(Object.getOwnPropertyDescriptor(stream, 'write'), writeDescriptor)
  } catch {
    return false
  }
}

/**
 * @param {ConsoleRecord[]} records
 */
function publishRecords (records) {
  if (records.length === 0) return

  /** @type {Iterable<ConsoleRecord>} */
  let recordsToPublish = records
  if (records.length > 1) {
    const recordsByWrite = new Map()
    for (const record of records) {
      // Console implementations can delegate to another wrapped method. In
      // that case both wrappers observe the same write and the outer method is
      // the logical log record.
      recordsByWrite.set(record.writeId, record)
    }
    recordsToPublish = [...recordsByWrite.values()].sort((a, b) => a.writeId - b.writeId)
  }

  const previousCapture = activeCapture
  activeCapture = undefined
  isPublishing = true
  try {
    for (const record of recordsToPublish) {
      const payload = { method: record.method, message: record.message }
      if (Object.hasOwn(record, 'logHolder')) payload.logHolder = record.logHolder
      logSubmissionCh.publish(payload)
    }
  } finally {
    isPublishing = false
    activeCapture = previousCapture
  }
}

/**
 * @param {ConsoleRecord[]} records
 * @param {boolean} lastOnly
 * @returns {ConsoleRecord | undefined}
 */
function combineRecords (records, lastOnly) {
  if (records.length === 0) return

  const start = lastOnly ? records.length - 1 : 0
  let message = ''
  for (let i = start; i < records.length; i++) {
    message += records[i].message
  }
  if (message.endsWith('\n')) message = message.slice(0, -1)
  return { ...records[start], message }
}

/**
 * @param {object} target
 * @param {string} message
 */
function formatNodeConsoleMessage (target, message) {
  let groupIndentKey = nodeConsoleGroupIndentKeys.get(target)
  if (groupIndentKey === undefined) {
    groupIndentKey = Reflect.ownKeys(target).find(key => {
      return typeof key === 'symbol' &&
        (key.description === 'kGroupIndent' || key.description === 'kGroupIndentationString')
    }) || false
    nodeConsoleGroupIndentKeys.set(target, groupIndentKey)
  }
  const groupIndent = groupIndentKey && target[groupIndentKey]
  if (groupIndent) return groupIndent + message.replaceAll('\n', `\n${groupIndent}`)
  return message
}

/**
 * @param {object | Function} target
 * @param {string} method
 * @param {ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>} descriptor
 */
function usesNodeConsoleWrite (target, method, descriptor) {
  if (target === Console.prototype) return descriptor?.value === nodeConsoleMethods.get(method)

  try {
    const name = descriptor?.value?.name
    return (name === method || name === `bound ${method}`) &&
      Function.prototype.toString.call(descriptor.value) === 'function () { [native code] }'
  } catch {
    return false
  }
}

/**
 * @param {object | Function} target
 */
function wrapNodeConsoleWrite (target) {
  if (!nodeConsoleWrite) return false

  let owner
  try {
    owner = Object.hasOwn(target, nodeConsoleWrite) ? target : Console.prototype
    if (nodeConsoleWriteOwners.has(owner)) return true

    const descriptor = Object.getOwnPropertyDescriptor(owner, nodeConsoleWrite)
    if (typeof descriptor?.value !== 'function') return false

    // Node formats arguments before this internal writer runs. Capturing here preserves the exact output
    // without making a temporary stream.write replacement visible to custom inspectors.
    descriptor.value = shimmer.wrapFunction(descriptor.value, original => function (streamSymbol, message) {
      const capture = activeCapture
      let record
      if (!isPublishing && streamSymbol?.description === 'kUseStderr' && typeof message === 'string') {
        try {
          message = formatNodeConsoleMessage(this, message)
          if (capture?.nodeConsole) {
            record = createRecord(capture.method, message, ++nextWriteId, capture.captureLogHolder)
            capture.observedRecords.push(record)
            capture.ownRecords.push(record)
            record = undefined
          } else if (!capture && shouldCaptureLogs()) {
            // Console instances bind their methods during construction. Instances created before instrumentation
            // cannot be wrapped afterward, and the shared writer does not receive the original method name.
            record = createRecord('error', message, ++nextWriteId)
          }
        } catch {}
      }
      const result = original.apply(this, arguments)
      if (record) publishRecords([record])
      return result
    })
    Object.defineProperty(owner, nodeConsoleWrite, descriptor)
    nodeConsoleWriteOwners.add(owner)
  } catch {}
  return Boolean(owner && nodeConsoleWriteOwners.has(owner))
}

/**
 * @param {unknown} target
 * @param {(() => LogHolder | undefined) | undefined} [captureLogHolder]
 * @param {(() => boolean) | undefined} [captureAllowed]
 */
function wrapConsole (target, captureLogHolder, captureAllowed) {
  const targetType = typeof target
  if ((targetType !== 'object' && targetType !== 'function') || target === null) return
  if (wrappedTargets.has(target)) return

  let isNodeConsoleTarget = target === nodeConsole || target === Console.prototype
  try {
    if (!isNodeConsoleTarget && Object.getOwnPropertyDescriptor(target, '_stderrErrorHandler')) {
      isNodeConsoleTarget = Object.getPrototypeOf(target) === Console.prototype
    }
  } catch {}
  const hasNodeConsoleWrite = isNodeConsoleTarget && wrapNodeConsoleWrite(target)

  wrappedTargets.add(target)
  for (const method of methods) {
    const descriptor = getPropertyDescriptor(target, method)
    // Accessor-backed replacements cannot be inspected without running user
    // code, so leave them untouched.
    if (typeof descriptor?.value !== 'function') continue
    const useNodeConsoleWrite = hasNodeConsoleWrite && usesNodeConsoleWrite(target, method, descriptor)

    // Console methods are bound onto instances at runtime, so Orchestrion cannot
    // rewrite every receiver that test frameworks create or replace.
    const wrapMethod = original => function () {
      const shouldCapture = shouldCaptureLogs(captureAllowed)
      let capture
      let parentCapture
      let stream
      let writeDescriptor
      let writeInstallationAttempted = false
      let getOriginalWrite
      let originalWrite
      let captureActive = false
      let writeActive = false
      let wrappedWrite

      if (shouldCapture && useNodeConsoleWrite) {
        parentCapture = activeCapture
        capture = {
          captureLogHolder,
          method,
          nodeConsole: true,
          records: parentCapture?.records || [],
          observedRecords: [],
          ownRecords: [],
        }
        activeCapture = capture
        captureActive = true
      } else if (shouldCapture) {
        try {
          const streamTarget = target === nodeConsole ? target : this
          const streamDescriptor = getPropertyDescriptor(streamTarget, '_stderr') ||
            (streamTarget === target ? undefined : getPropertyDescriptor(target, '_stderr'))
          stream = streamDescriptor?.value
          // Node's global console owns a known lazy accessor. Avoid invoking arbitrary replacement
          // console accessors, but preserve capture for the built-in global console.
          if (!stream && target === nodeConsole && typeof nativeStderrDescriptor?.get === 'function' &&
            descriptorsMatch(streamDescriptor, nativeStderrDescriptor)) {
            stream = nativeStderrDescriptor.get.call(target)
          }
          writeDescriptor = stream && Object.getOwnPropertyDescriptor(stream, 'write')
          const isUnwrappableAccessor = writeDescriptor &&
            !Object.hasOwn(writeDescriptor, 'value') &&
            !writeDescriptor.configurable
          const canInstallWrite = Boolean(
            stream && !disabledStreams.has(stream) && (writeDescriptor || Object.isExtensible(stream))
          )
          if (!isUnwrappableAccessor && canInstallWrite) {
            let originalWriteDescriptor = writeDescriptor
            if (!originalWriteDescriptor && stream) {
              originalWriteDescriptor = getPropertyDescriptor(Object.getPrototypeOf(stream), 'write')
            }
            if (originalWriteDescriptor && Object.hasOwn(originalWriteDescriptor, 'value')) {
              originalWrite = originalWriteDescriptor.value
            } else {
              getOriginalWrite = originalWriteDescriptor?.get
            }
          }
          if (typeof originalWrite === 'function' || typeof getOriginalWrite === 'function') {
            wrappedWrite = function (chunk) {
              const write = getOriginalWrite ? getOriginalWrite.call(stream) : originalWrite
              if (isPublishing || !captureActive || writeActive) return Reflect.apply(write, this, arguments)

              writeActive = true
              const previousWriteId = activeWriteId
              const previousExpectedWrite = expectedWrite
              const isNewWrite = expectedWrite !== wrappedWrite
              const writeId = isNewWrite ? ++nextWriteId : activeWriteId
              activeWriteId = writeId
              expectedWrite = write
              try {
                if (typeof chunk === 'string') {
                  const record = createRecord(method, chunk, writeId, captureLogHolder)
                  // Nested calls pass through outer write wrappers. Keep all
                  // observations for delegation, but only claim writes that
                  // started while this console call was active.
                  capture.observedRecords.push(record)
                  if (activeCapture === capture) capture.ownRecords.push(record)
                }
                return Reflect.apply(write, this, arguments)
              } finally {
                activeWriteId = previousWriteId
                expectedWrite = previousExpectedWrite
                writeActive = false
              }
            }
            writeInstallationAttempted = true
            Object.defineProperty(stream, 'write', {
              configurable: writeDescriptor?.configurable ?? true,
              enumerable: writeDescriptor?.enumerable ?? true,
              writable: true,
              value: wrappedWrite,
            })
            if (Object.getOwnPropertyDescriptor(stream, 'write')?.value !== wrappedWrite) {
              if (!restoreStreamWrite(stream, writeDescriptor)) disabledStreams.add(stream)
              wrappedWrite = undefined
            }
            if (wrappedWrite) {
              parentCapture = activeCapture
              capture = {
                captureLogHolder,
                method,
                nodeConsole: false,
                records: parentCapture?.records || [],
                observedRecords: [],
                ownRecords: [],
              }
              activeCapture = capture
              captureActive = true
            }
          }
        } catch {
          if (writeInstallationAttempted && !restoreStreamWrite(stream, writeDescriptor)) {
            disabledStreams.add(stream)
          }
          wrappedWrite = undefined
        }
      }

      let completed = false
      try {
        const result = original.apply(this, arguments)
        completed = true
        return result
      } finally {
        if (capture) {
          captureActive = false
          if (wrappedWrite && !restoreStreamWrite(stream, writeDescriptor, wrappedWrite)) disabledStreams.add(stream)
          activeCapture = parentCapture

          let consoleRecord
          if (completed) {
            // A replacement console may split one record across writes. Node's Console instead
            // uses one final write, after any unrelated writes produced while formatting.
            if (capture.ownRecords.length > 0) {
              consoleRecord = combineRecords(capture.ownRecords, isNodeConsoleTarget)
            } else if (capture.observedRecords.length > 0) {
              consoleRecord = combineRecords(capture.observedRecords, isNodeConsoleTarget)
            }
          }
          if (consoleRecord) capture.records.push(consoleRecord)
          if (!parentCapture) publishRecords(capture.records)
        }
      }
    }
    try {
      descriptor.value = shimmer.wrapFunction(descriptor.value, wrapMethod)
      Object.defineProperty(target, method, descriptor)
    } catch {}
  }
}

/**
 * @param {JestBufferedConsole | undefined} BufferedConsole
 * @param {(() => LogHolder | undefined) | undefined} [captureLogHolder]
 * @param {(() => boolean) | undefined} [captureAllowed]
 */
function wrapJestBufferedConsole (BufferedConsole, captureLogHolder, captureAllowed) {
  if (!BufferedConsole || wrappedTargets.has(BufferedConsole)) return

  wrappedTargets.add(BufferedConsole)
  // Jest buffers records through this static method without calling Node's
  // Console methods. Wrapping it also preserves Jest's user-facing callsite.
  shimmer.wrap(BufferedConsole, 'write', original => function (buffer, method, message) {
    const shouldPublish = methodSet.has(method) && shouldCaptureLogs(captureAllowed)
    if (shouldPublish) {
      const activeRecord = activeCapture?.observedRecords.at(-1)
      const isActiveWrite = activeRecord?.writeId === activeWriteId &&
        activeRecord.method === method &&
        (activeRecord.message === message || activeRecord.message === `${message}\n`)
      const writeId = isActiveWrite ? activeWriteId : ++nextWriteId
      const record = createRecord(method, message, writeId, captureLogHolder)
      if (activeCapture) {
        activeCapture.records.push(record)
      } else {
        publishRecords([record])
      }

      // Some Jest versions render the buffered record through another wrapped
      // console method. The buffered message is already the logical record, so
      // suppress that internal rendering path.
      isPublishing = true
      try {
        return original.apply(this, arguments)
      } finally {
        isPublishing = false
      }
    }
    return original.apply(this, arguments)
  })
}

/**
 * @param {JestCustomConsole | undefined} CustomConsole
 * @param {(() => LogHolder | undefined) | undefined} [captureLogHolder]
 * @param {(() => boolean) | undefined} [captureAllowed]
 */
function wrapJestCustomConsole (CustomConsole, captureLogHolder, captureAllowed) {
  if (!CustomConsole || wrappedTargets.has(CustomConsole)) return

  wrappedTargets.add(CustomConsole)
  // This must bracket Jest's internal rendering with the same in-module guard used by stream wrappers,
  // so splitting the interception across Orchestrion channel subscribers would not preserve the contract.
  try {
    shimmer.wrap(CustomConsole.prototype, '_logError', original => function (method, message) {
      const shouldPublish = methodSet.has(method) && shouldCaptureLogs(captureAllowed)
      if (!shouldPublish) return original.apply(this, arguments)

      const record = createRecord(method, message, ++nextWriteId, captureLogHolder)
      if (activeCapture) {
        activeCapture.records.push(record)
      } else {
        publishRecords([record])
      }

      const wasPublishing = isPublishing
      isPublishing = true
      try {
        return original.apply(this, arguments)
      } finally {
        isPublishing = wasPublishing
      }
    })
  } catch {}
}

configureCh.subscribe(({ canCapture, getLogHolder: configuredGetLogHolder } = {}) => {
  getLogHolder = configuredGetLogHolder
  isLogSubmissionAllowed = canCapture
  // The global console has bound own methods, while Console.prototype covers
  // instances that are created after log submission is enabled.
  wrapConsole(globalThis.console)
  wrapConsole(Console.prototype)
})

module.exports = { wrapConsole, wrapJestBufferedConsole, wrapJestCustomConsole }
