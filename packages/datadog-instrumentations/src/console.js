'use strict'

const { Buffer } = require('node:buffer')
const nodeConsole = require('node:console')

let nativeStderrDescriptor
let nodeConsoleFormatForStderr
let nodeConsolePrototype
let nodeConsoleWrite
try {
  nativeStderrDescriptor = Object.getOwnPropertyDescriptor(nodeConsole, '_stderr')
} catch {}
try {
  const consoleDescriptor = Object.getOwnPropertyDescriptor(nodeConsole, 'Console')
  if (typeof consoleDescriptor?.value === 'function') {
    const prototype = consoleDescriptor.value.prototype
    const keys = Reflect.ownKeys(prototype)
    nodeConsolePrototype = prototype
    nodeConsoleWrite = keys.find(key => {
      return typeof key === 'symbol' && key.description === 'kWriteToConsole'
    })
    nodeConsoleFormatForStderr = keys.find(key => {
      return typeof key === 'symbol' && key.description === 'kFormatForStderr'
    })
  }
} catch {}

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const configureCh = channel('ci:log-submission:console:configure')
const logSubmissionCh = channel('ci:log-submission:console')
// Keep routine test output local while submitting diagnostics that can explain failures.
const methods = ['error', 'warn']
const unsupportedMethods = new Set(['assert', 'trace'])
const methodSet = new Set(methods)
const nodeConsoleMethods = new Map()
const unsupportedNodeConsoleMethods = new Set()
if (nodeConsolePrototype) {
  try {
    for (const method of methods) {
      nodeConsoleMethods.set(method, Object.getOwnPropertyDescriptor(nodeConsolePrototype, method)?.value)
    }
    for (const method of unsupportedMethods) {
      const fn = Object.getOwnPropertyDescriptor(nodeConsolePrototype, method)?.value
      if (typeof fn === 'function') unsupportedNodeConsoleMethods.add(fn)
    }
  } catch {}
}
const nodeConsoleBoundMethods = new Map()
try {
  for (const method of methods) {
    nodeConsoleBoundMethods.set(method, Object.getOwnPropertyDescriptor(nodeConsole, method)?.value)
  }
} catch {}
const disabledStreams = new WeakSet()
/** @type {WeakMap<object, symbol | false>} */
const nodeConsoleGroupIndentKeys = new WeakMap()
const nodeConsoleWriteOwners = new WeakSet()
const suppressionWrappedTargets = new WeakSet()
const wrappedTargets = new WeakSet()
/** @type {{ capture?: ConsoleCapture, method: string }[]} */
const pendingNodeConsoleCalls = []

/** @typedef {{ dd: object }} LogHolder */
/**
 * @typedef {{
 *   getFunction?: () => Function | undefined,
 *   getFunctionName?: () => string | null,
 *   getMethodName?: () => string | null,
 *   getTypeName?: () => string | null
 * }} CallSite
 */
/**
 * @typedef {{
 *   formatting?: boolean,
 *   logHolder?: LogHolder,
 *   method: string,
 *   message: string,
 *   writeId: number
 * }} ConsoleRecord
 */
/**
 * @typedef {{
 *   captureLogHolder?: () => LogHolder | undefined,
 *   method: string,
 *   methodSignaled?: boolean,
 *   nativeTarget: boolean,
 *   nodeConsole: boolean,
 *   observedRecords: ConsoleRecord[],
 *   ownRecords: ConsoleRecord[],
 *   receiver?: object | Function,
 *   records: ConsoleRecord[]
 * }} ConsoleCapture
 */

/** @type {ConsoleCapture | undefined} */
let activeCapture
/** @type {ConsoleCapture | undefined} */
let activeNodeConsoleFormatCapture
/** @type {ConsoleCapture | undefined} */
let activeNodeConsoleWriteCapture
let activeWriteId = 0
let expectedWrite
/** @type {(() => LogHolder | undefined) | undefined} */
let getLogHolder
/** @type {(() => boolean) | undefined} */
let isLogSubmissionAllowed
let areNodeConsoleDiagnosticsSubscribed = false
let hasNodeConsoleWriteConsumer = false
let isPublishing = false
let nextWriteId = 0
let suppressedConsoleDepth = 0

function subscribeNodeConsoleDiagnostics () {
  if (areNodeConsoleDiagnosticsSubscribed) return

  areNodeConsoleDiagnosticsSubscribed = true
  for (const method of methods) {
    // Newer Node versions publish these channels before formatting, allowing
    // pre-existing bound Console methods to retain their severity without
    // depending on application-controlled stack traces.
    channel(`console.${method}`).subscribe(() => {
      if (!shouldCaptureLogs()) return

      let capture
      if (activeCapture && !activeCapture.methodSignaled && activeCapture.method === method) {
        capture = activeCapture
        capture.methodSignaled = true
      }
      // Active method wrappers remove their tagged entry after stream interception. Untagged entries require an
      // installed private writer wrapper; otherwise they can never be consumed.
      if (!capture && !hasNodeConsoleWriteConsumer) return
      pendingNodeConsoleCalls.push({ capture, method })
    })
  }
}

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
  if (isPublishing || suppressedConsoleDepth > 0 || !logSubmissionCh.hasSubscribers) return false

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
 * @param {object | Function} target
 * @param {object} expectedPrototype
 */
function inheritsFrom (target, expectedPrototype) {
  try {
    let prototype = Object.getPrototypeOf(target)
    let prototypes
    while (prototype && !prototypes?.has(prototype)) {
      if (prototype === expectedPrototype) return true
      prototypes ||= new Set()
      prototypes.add(prototype)
      prototype = Object.getPrototypeOf(prototype)
    }
  } catch {}
  return false
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
 * @param {boolean} [trimTerminator]
 * @returns {ConsoleRecord | undefined}
 */
function combineRecords (records, lastOnly, trimTerminator = true) {
  if (records.length === 0) return

  let firstRecord
  let message = ''
  for (let i = lastOnly ? records.length - 1 : 0; i < records.length; i++) {
    const record = records[i]
    if (record.formatting) continue
    firstRecord ||= record
    message += record.message
  }
  if (!firstRecord) return
  if (trimTerminator) {
    if (message.endsWith('\r\n')) {
      message = message.slice(0, -2)
    } else if (message.endsWith('\n')) {
      message = message.slice(0, -1)
    }
  }
  return { ...firstRecord, message }
}

/**
 * @param {ConsoleCapture} capture
 */
function removePendingNodeConsoleCall (capture) {
  for (let i = pendingNodeConsoleCalls.length - 1; i >= 0; i--) {
    if (pendingNodeConsoleCalls[i].capture !== capture) continue

    pendingNodeConsoleCalls.splice(i, 1)
    return
  }
}

function prepareCallSites (_, callSites) {
  return callSites
}

/**
 * @param {Function} skipFunction
 * @returns {CallSite[] | undefined}
 */
function getCallSites (skipFunction) {
  let descriptor
  let isReplaced = false
  try {
    // Reading error.stack normally invokes the application's formatter. Replace it only when its descriptor can be
    // restored synchronously; otherwise degrade call-site detection without executing application code.
    descriptor = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
    if (descriptor && !descriptor.configurable &&
      (!Object.hasOwn(descriptor, 'value') || !descriptor.writable)) return

    Object.defineProperty(Error, 'prepareStackTrace', {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      value: prepareCallSites,
      writable: true,
    })
    isReplaced = true
    const error = {}
    Error.captureStackTrace(error, skipFunction)
    const callSites = error.stack
    if (Array.isArray(callSites)) return callSites
  } catch {} finally {
    if (isReplaced) {
      try {
        if (descriptor) {
          Object.defineProperty(Error, 'prepareStackTrace', descriptor)
        } else {
          delete Error.prepareStackTrace
        }
      } catch {}
    }
  }
}

/**
 * @param {Function} skipFunction
 * @param {Function} consoleMethod
 */
function isCustomInspectWrite (skipFunction, consoleMethod) {
  try {
    // Replacement consoles can write while util.inspect is formatting their arguments. A custom inspector may
    // delegate that write through helpers, so inspect frames up to the console method that owns the record.
    const callSites = getCallSites(skipFunction)
    if (!callSites) return false
    for (const callSite of callSites) {
      if (callSite?.getFunction?.() === consoleMethod) return false
      const method = callSite?.getMethodName?.() || callSite?.getFunctionName?.()
      if (String(method).includes('nodejs.util.inspect.custom')) return true
    }
  } catch {}
  return false
}

/**
 * @param {unknown} chunk
 * @returns {string | undefined}
 */
function decodeChunk (chunk) {
  if (typeof chunk === 'string') return chunk
  if (!Buffer.isBuffer(chunk) && !ArrayBuffer.isView(chunk)) return

  try {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    return buffer.toString()
  } catch {}
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
  if (!groupIndentKey) return message

  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, groupIndentKey)
  } catch {
    return
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return

  const groupIndent = descriptor.value
  if (groupIndent) return groupIndent + message.replaceAll('\n', `\n${groupIndent}`)
  return message
}

/**
 * @param {Function} skipFunction
 * @param {object} target
 * @param {string | undefined} pendingMethod
 * @returns {string | false | undefined}
 */
function getNodeConsoleMethod (skipFunction, target, pendingMethod) {
  try {
    const callSites = getCallSites(skipFunction)
    if (callSites) {
      const targetName = getPropertyDescriptor(target, 'constructor')?.value?.name
      let supportedMethod
      for (const callSite of callSites) {
        const method = callSite?.getMethodName?.() || callSite?.getFunctionName?.()
        const fn = callSite?.getFunction?.()
        const type = callSite?.getTypeName?.()
        const isTargetMethod = type === 'Console' || type === 'console' || type === targetName
        if (unsupportedNodeConsoleMethods.has(fn) || (isTargetMethod && unsupportedMethods.has(method))) return false
        if (!supportedMethod && methodSet.has(method)) supportedMethod = method
      }
      return pendingMethod || supportedMethod
    }
  } catch {}
  return pendingMethod
}

/**
 * @param {object | Function} target
 * @param {string} method
 * @param {ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>} descriptor
 */
function usesNodeConsoleWrite (target, method, descriptor) {
  if (target === nodeConsolePrototype) return descriptor?.value === nodeConsoleMethods.get(method)
  if (target === nodeConsole) return descriptor?.value === nodeConsoleBoundMethods.get(method)

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
function wrapUnsupportedNodeConsoleMethods (target) {
  if (suppressionWrappedTargets.has(target)) return

  suppressionWrappedTargets.add(target)
  for (const method of unsupportedMethods) {
    const descriptor = getPropertyDescriptor(target, method)
    if (typeof descriptor?.value !== 'function') continue

    try {
      // Console methods are bound onto instances at runtime, so Orchestrion cannot
      // bracket every receiver that test frameworks create or replace.
      descriptor.value = shimmer.wrapFunction(descriptor.value, original => function () {
        suppressedConsoleDepth++
        try {
          return original.apply(this, arguments)
        } finally {
          suppressedConsoleDepth--
        }
      })
      Object.defineProperty(target, method, descriptor)
    } catch {}
  }
}

/**
 * @param {object | Function} target
 */
function wrapNodeConsoleWrite (target) {
  if (!nodeConsoleWrite || !nodeConsolePrototype) return false

  let owner
  try {
    owner = Object.hasOwn(target, nodeConsoleWrite) ? target : nodeConsolePrototype
    if (nodeConsoleWriteOwners.has(owner)) {
      hasNodeConsoleWriteConsumer = true
      return true
    }

    const descriptor = Object.getOwnPropertyDescriptor(owner, nodeConsoleWrite)
    if (typeof descriptor?.value !== 'function') return false

    if (nodeConsoleFormatForStderr) {
      const formatDescriptor = Object.getOwnPropertyDescriptor(owner, nodeConsoleFormatForStderr)
      if (typeof formatDescriptor?.value === 'function') {
        formatDescriptor.value = shimmer.wrapFunction(formatDescriptor.value, original => function () {
          const previousFormatCapture = activeNodeConsoleFormatCapture
          activeNodeConsoleFormatCapture = activeCapture
          try {
            return original.apply(this, arguments)
          } catch (error) {
            // The console diagnostics channel runs before formatting. Do not
            // leave its method behind when formatting aborts before a write.
            const pendingCall = pendingNodeConsoleCalls.at(-1)
            if (!pendingCall?.capture || pendingCall.capture === activeCapture) pendingNodeConsoleCalls.pop()
            throw error
          } finally {
            activeNodeConsoleFormatCapture = previousFormatCapture
          }
        })
        Object.defineProperty(owner, nodeConsoleFormatForStderr, formatDescriptor)
      }
    }

    // Node formats arguments before this internal writer runs. Capturing here preserves the exact output
    // without making a temporary stream.write replacement visible to custom inspectors.
    descriptor.value = shimmer.wrapFunction(descriptor.value, original => function nodeConsoleWriteWithTrace (
      streamSymbol,
      message
    ) {
      const capture = activeCapture
      const isStderr = streamSymbol?.description === 'kUseStderr'
      const pendingCall = isStderr ? pendingNodeConsoleCalls.pop() : undefined
      const isNestedNodeConsoleCall = Boolean(capture &&
        (activeNodeConsoleFormatCapture === capture || activeNodeConsoleWriteCapture === capture))
      let record
      let observedRecordIndex = -1
      let ownRecordIndex = -1
      if (!isPublishing && suppressedConsoleDepth === 0 && isStderr && typeof message === 'string') {
        try {
          const formattedMessage = formatNodeConsoleMessage(this, message)
          if (formattedMessage !== undefined) {
            message = formattedMessage
            const detectedMethod = getNodeConsoleMethod(nodeConsoleWriteWithTrace, this, pendingCall?.method)
            const isCaptureWrite = detectedMethod !== false && !isNestedNodeConsoleCall &&
              capture?.nodeConsole && capture.receiver === this && (!pendingCall || pendingCall.capture === capture)
            if (isCaptureWrite) {
              record = createRecord(capture.method, message, ++nextWriteId, capture.captureLogHolder)
              observedRecordIndex = capture.observedRecords.length
              capture.observedRecords.push(record)
              ownRecordIndex = capture.ownRecords.length
              capture.ownRecords.push(record)
              record = undefined
            } else {
              // Console instances bind their methods during construction. Instances created before instrumentation
              // cannot be wrapped afterward. Newer Node versions publish the
              // method before formatting; older versions retain the stack-based
              // fallback.
              const method = detectedMethod === false ? undefined : detectedMethod
              const isActiveCall = !isNestedNodeConsoleCall && capture && !capture.nodeConsole && capture.nativeTarget
              if (!isActiveCall && method && shouldCaptureLogs()) {
                record = createRecord(method, message, ++nextWriteId)
              }
            }
          }
        } catch {}
      }
      let result
      let writeCompleted = false
      const previousWriteCapture = activeNodeConsoleWriteCapture
      activeNodeConsoleWriteCapture = capture
      try {
        result = original.apply(this, arguments)
        writeCompleted = true
      } finally {
        if (!writeCompleted) {
          if (ownRecordIndex >= 0) capture.ownRecords.splice(ownRecordIndex, 1)
          if (observedRecordIndex >= 0) capture.observedRecords.splice(observedRecordIndex, 1)
        }
        activeNodeConsoleWriteCapture = previousWriteCapture
      }
      if (record) {
        if (capture) {
          capture.records.push(record)
        } else {
          publishRecords([record])
        }
      }
      return result
    })
    Object.defineProperty(owner, nodeConsoleWrite, descriptor)
    nodeConsoleWriteOwners.add(owner)
    hasNodeConsoleWriteConsumer = true
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

  let isNodeConsoleTarget = target === nodeConsole || target === nodeConsolePrototype
  try {
    if (!isNodeConsoleTarget && nodeConsolePrototype &&
      Object.getOwnPropertyDescriptor(target, '_stderrErrorHandler')) {
      isNodeConsoleTarget = inheritsFrom(target, nodeConsolePrototype)
    }
  } catch {}
  const hasNodeConsoleWrite = isNodeConsoleTarget && wrapNodeConsoleWrite(target)
  if (isNodeConsoleTarget) wrapUnsupportedNodeConsoleMethods(target)

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
      let originalWrite
      let captureActive = false
      let writeActive = false
      let wrappedWrite

      if (shouldCapture && useNodeConsoleWrite) {
        parentCapture = activeCapture
        capture = {
          captureLogHolder,
          method,
          nativeTarget: isNodeConsoleTarget,
          nodeConsole: true,
          records: parentCapture?.records || [],
          observedRecords: [],
          ownRecords: [],
          receiver: target === nodeConsolePrototype ? this : target,
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
          const isOwnAccessor = writeDescriptor && !Object.hasOwn(writeDescriptor, 'value')
          const canInstallWrite = Boolean(
            stream && !isOwnAccessor && !disabledStreams.has(stream) &&
            (writeDescriptor || Object.isExtensible(stream))
          )
          if (canInstallWrite) {
            let originalWriteDescriptor = writeDescriptor
            if (!originalWriteDescriptor && stream) {
              originalWriteDescriptor = getPropertyDescriptor(Object.getPrototypeOf(stream), 'write')
            }
            if (originalWriteDescriptor && Object.hasOwn(originalWriteDescriptor, 'value')) {
              originalWrite = originalWriteDescriptor.value
            }
          }
          // Invoking an accessor from inside the wrapper would reverse property lookup and argument evaluation.
          if (typeof originalWrite === 'function') {
            wrappedWrite = function (chunk) {
              if (isPublishing || !captureActive || writeActive) return Reflect.apply(originalWrite, this, arguments)

              writeActive = true
              const previousWriteId = activeWriteId
              const previousExpectedWrite = expectedWrite
              const isNewWrite = expectedWrite !== wrappedWrite
              const writeId = isNewWrite ? ++nextWriteId : activeWriteId
              activeWriteId = writeId
              expectedWrite = originalWrite
              let ownRecordIndex = -1
              let observedRecordIndex = -1
              let writeCompleted = false
              try {
                const message = decodeChunk(chunk)
                if (message !== undefined) {
                  const record = createRecord(method, message, writeId, captureLogHolder)
                  if (isCustomInspectWrite(wrappedWrite, original)) record.formatting = true
                  // Nested calls pass through outer write wrappers. Keep all
                  // observations for delegation, but only claim writes that
                  // started while this console call was active.
                  observedRecordIndex = capture.observedRecords.length
                  capture.observedRecords.push(record)
                  if (activeCapture === capture) {
                    ownRecordIndex = capture.ownRecords.length
                    capture.ownRecords.push(record)
                  }
                }
                const result = Reflect.apply(originalWrite, this, arguments)
                writeCompleted = true
                return result
              } finally {
                if (!writeCompleted) {
                  if (ownRecordIndex >= 0) capture.ownRecords.splice(ownRecordIndex, 1)
                  if (observedRecordIndex >= 0) capture.observedRecords.splice(observedRecordIndex, 1)
                }
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
                nativeTarget: isNodeConsoleTarget,
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

      try {
        return original.apply(this, arguments)
      } finally {
        if (capture) {
          captureActive = false
          if (wrappedWrite && !restoreStreamWrite(stream, writeDescriptor, wrappedWrite)) disabledStreams.add(stream)
          if (!capture.nodeConsole) removePendingNodeConsoleCall(capture)
          activeCapture = parentCapture

          let consoleRecord
          // A replacement console may split one record across writes. Node's Console instead
          // uses one final write, after any unrelated writes produced while formatting.
          if (capture.ownRecords.length > 0) {
            consoleRecord = combineRecords(capture.ownRecords, isNodeConsoleTarget, !capture.nodeConsole)
          } else if (capture.observedRecords.length > 0) {
            consoleRecord = combineRecords(capture.observedRecords, isNodeConsoleTarget, !capture.nodeConsole)
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
      const capture = activeCapture

      // Some Jest versions render the buffered record through another wrapped
      // console method. The buffered message is already the logical record, so
      // suppress that internal rendering path.
      const wasPublishing = isPublishing
      isPublishing = true
      let result
      try {
        result = original.apply(this, arguments)
      } finally {
        isPublishing = wasPublishing
      }
      if (capture) {
        capture.records.push(record)
      } else {
        publishRecords([record])
      }
      return result
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
      const capture = activeCapture

      const wasPublishing = isPublishing
      isPublishing = true
      let result
      try {
        result = original.apply(this, arguments)
      } finally {
        isPublishing = wasPublishing
      }
      if (capture) {
        capture.records.push(record)
      } else {
        publishRecords([record])
      }
      return result
    })
  } catch {}
}

configureCh.subscribe(({ canCapture, getLogHolder: configuredGetLogHolder } = {}) => {
  getLogHolder = configuredGetLogHolder
  isLogSubmissionAllowed = canCapture
  subscribeNodeConsoleDiagnostics()
  // The global console has bound own methods, while Console.prototype covers
  // instances that are created after log submission is enabled.
  let globalConsole
  try {
    globalConsole = globalThis.console
  } catch {}
  wrapConsole(globalConsole)
  wrapConsole(nodeConsolePrototype)
})

module.exports = { wrapConsole, wrapJestBufferedConsole, wrapJestCustomConsole }
