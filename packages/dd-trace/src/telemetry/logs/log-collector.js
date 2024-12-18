'use strict'

const log = require('../../log')
const { calculateDDBasePath } = require('../../util')

const logs = new Map() // hash -> log

// NOTE: Is this a reasonable number?
let maxEntries = 10000
let overflowedCount = 0

function hashCode (hashSource) {
  let hash = 0
  const size = hashSource.length
  for (let offset = 0; offset < size; offset++) {
    hash = (((hash * 31) | 0) + hashSource.charCodeAt(offset)) | 0
  }
  return hash
}

function createHash (logEntry) {
  const prime = 31
  let result = ((!logEntry.level) ? 0 : hashCode(logEntry.level))
  result = (((prime * result) | 0) + ((!logEntry.message) ? 0 : hashCode(logEntry.message))) | 0
  result = (((prime * result) | 0) + ((!logEntry.stack_trace) ? 0 : hashCode(logEntry.stack_trace))) | 0
  return result
}

function isValid (logEntry) {
  return logEntry?.level && logEntry.message
}

const ddBasePath = calculateDDBasePath(__dirname)
const EOL = '\n'
const STACK_FRAME_LINE_REGEX = /^\s*at\s/gm

function sanitize (logEntry) {
  const stack = logEntry.stack_trace
  if (!stack) return logEntry

  let stackLines = stack.split(EOL)

  const firstIndex = stackLines.findIndex(l => l.match(STACK_FRAME_LINE_REGEX))

  const isDDCode = firstIndex > -1 && stackLines[firstIndex].includes(ddBasePath)
  stackLines = stackLines
    .filter((line, index) => (isDDCode && index < firstIndex) || line.includes(ddBasePath))
    .map(line => line.replace(ddBasePath, ''))

  if (!isDDCode && logEntry.errorType && stackLines.length) {
    stackLines = [`${logEntry.errorType}: redacted`, ...stackLines]
  }

  delete logEntry.errorType

  logEntry.stack_trace = stackLines.join(EOL)
  if (logEntry.stack_trace === '' && (!logEntry.message || logEntry.message === 'Generic Error')) {
    // If entire stack was removed and there is no message we'd rather not log it at all.
    return null
  }

  return logEntry
}

const logCollector = {
  add (logEntry) {
    try {
      if (!isValid(logEntry)) return false

      // NOTE: should errors have higher priority? and discard log entries with lower priority?
      if (logs.size >= maxEntries) {
        overflowedCount++
        return false
      }

      logEntry = sanitize(logEntry)
      if (!logEntry) {
        return false
      }
      const hash = createHash(logEntry)
      if (!logs.has(hash)) {
        logs.set(hash, logEntry)
        return true
      } else {
        logs.get(hash).count++
      }
    } catch (e) {
      log.error('Unable to add log to logCollector: %s', e.message)
    }
    return false
  },

  // Used for testing
  hasEntry (logEntry) {
    return logs.has(createHash(logEntry))
  },

  drain () {
    if (logs.size === 0) return

    const drained = [...logs.values()]

    if (overflowedCount > 0) {
      drained.push({
        message: `Omitted ${overflowedCount} entries due to overflowing`,
        level: 'ERROR'
      })
    }

    this.reset()

    return drained
  },

  reset (max) {
    logs.clear()
    overflowedCount = 0

    if (max) {
      maxEntries = max
    }
  }
}

logCollector.reset()

module.exports = logCollector
