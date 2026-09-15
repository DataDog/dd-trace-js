'use strict'

const { Console } = require('node:console')

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const configureCh = channel('ci:log-submission:console:configure')
const logSubmissionCh = channel('ci:log-submission:console')
// Keep routine test output local while submitting diagnostics that can explain failures.
const methods = ['error', 'warn']
const methodSet = new Set(methods)
const wrappedTargets = new WeakSet()

/** @typedef {{ dd: object }} LogHolder */
/** @typedef {{ logHolder?: LogHolder, method: string, message: string, writeId: number }} ConsoleRecord */
/**
 * @typedef {{
 *   fallbackRecord?: ConsoleRecord,
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
let isPublishing = false
let nextWriteId = 0

/** @typedef {{ write: (buffer: unknown, method: string, message: string) => unknown }} JestBufferedConsole */

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
 * @param {Record<string, unknown>} stream
 * @param {ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>} writeDescriptor
 * @param {Function} [expectedWrite]
 * @returns {void}
 */
function restoreStreamWrite (stream, writeDescriptor, expectedWrite) {
  try {
    if (expectedWrite && Object.getOwnPropertyDescriptor(stream, 'write')?.value !== expectedWrite) return
    if (writeDescriptor) {
      Object.defineProperty(stream, 'write', writeDescriptor)
    } else {
      delete stream.write
    }
  } catch {}
}

/**
 * @param {ConsoleRecord[]} records
 * @returns {void}
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
 * @param {Record<string, unknown> | undefined} target
 * @param {(() => LogHolder | undefined) | undefined} [captureLogHolder]
 * @returns {void}
 */
function wrapConsole (target, captureLogHolder) {
  if (!target || wrappedTargets.has(target)) return

  wrappedTargets.add(target)
  for (const method of methods) {
    let descriptor
    try {
      let owner = target
      while (owner && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(owner, method)
        owner = Object.getPrototypeOf(owner)
      }
    } catch {
      continue
    }
    // Accessor-backed replacements cannot be inspected without running user
    // code, so leave them untouched.
    if (typeof descriptor?.value !== 'function') continue

    // Console methods are bound onto instances at runtime, so Orchestrion cannot
    // rewrite every receiver that test frameworks create or replace.
    const wrapMethod = original => function () {
      const shouldCapture = !isPublishing && logSubmissionCh.hasSubscribers
      let capture
      let parentCapture
      let stream
      let writeDescriptor
      let writeInstallationAttempted = false
      let originalWrite
      let captureActive = false
      let wrappedWrite

      if (shouldCapture) {
        try {
          const receiver = this?._stderr ? this : target
          stream = receiver?._stderr
          originalWrite = stream?.write
          if (typeof originalWrite === 'function') {
            writeDescriptor = Object.getOwnPropertyDescriptor(stream, 'write')
            wrappedWrite = function (chunk) {
              if (!captureActive) return originalWrite.apply(this, arguments)

              const previousWriteId = activeWriteId
              const previousExpectedWrite = expectedWrite
              const isNewWrite = expectedWrite !== wrappedWrite
              const writeId = isNewWrite ? ++nextWriteId : activeWriteId
              activeWriteId = writeId
              expectedWrite = originalWrite
              try {
                if (typeof chunk === 'string') {
                  const message = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk
                  const record = createRecord(method, message, writeId, captureLogHolder)
                  // Nested calls pass through outer write wrappers. Keep all
                  // observations for delegation, but only claim writes that
                  // started while this console call was active.
                  capture.observedRecords.push(record)
                  if (activeCapture === capture) capture.ownRecords.push(record)
                }
                return originalWrite.apply(this, arguments)
              } finally {
                activeWriteId = previousWriteId
                expectedWrite = previousExpectedWrite
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
              restoreStreamWrite(stream, writeDescriptor)
              wrappedWrite = undefined
            }
            if (wrappedWrite) {
              parentCapture = activeCapture
              capture = { records: parentCapture?.records || [], observedRecords: [], ownRecords: [] }
              activeCapture = capture
              captureActive = true
            }
          }
        } catch {
          if (writeInstallationAttempted) restoreStreamWrite(stream, writeDescriptor)
          wrappedWrite = undefined
        }
      }

      let completed = false
      try {
        const result = original.apply(this, arguments)
        completed = true
        return result
      } finally {
        if (wrappedWrite) {
          captureActive = false
          restoreStreamWrite(stream, writeDescriptor, wrappedWrite)
          activeCapture = parentCapture

          if (completed) {
            if (capture.ownRecords.length > 0) {
              capture.records.push(...capture.ownRecords)
            } else if (capture.observedRecords.length > 0) {
              capture.records.push(...capture.observedRecords)
            } else if (capture.fallbackRecord) {
              capture.records.push(capture.fallbackRecord)
            }
          }
          if (!parentCapture) publishRecords(capture.records)
        }
      }
    }
    try {
      shimmer.wrap(target, method, wrapMethod)
    } catch {}
  }
}

/**
 * @param {JestBufferedConsole | undefined} BufferedConsole
 * @param {(() => LogHolder | undefined) | undefined} [captureLogHolder]
 * @returns {void}
 */
function wrapJestBufferedConsole (BufferedConsole, captureLogHolder) {
  if (!BufferedConsole || wrappedTargets.has(BufferedConsole)) return

  wrappedTargets.add(BufferedConsole)
  // Jest buffers records through this static method without calling Node's
  // Console methods. Wrapping it also preserves Jest's user-facing callsite.
  shimmer.wrap(BufferedConsole, 'write', original => function (buffer, method, message) {
    const shouldPublish = !isPublishing && methodSet.has(method) && logSubmissionCh.hasSubscribers
    if (shouldPublish) {
      const record = createRecord(method, message, ++nextWriteId, captureLogHolder)
      if (activeCapture) {
        activeCapture.fallbackRecord = record
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

configureCh.subscribe(({ getLogHolder: configuredGetLogHolder } = {}) => {
  getLogHolder = configuredGetLogHolder
  // The global console has bound own methods, while Console.prototype covers
  // instances that are created after log submission is enabled.
  wrapConsole(globalThis.console)
  wrapConsole(Console.prototype)
})

module.exports = { wrapConsole, wrapJestBufferedConsole }
