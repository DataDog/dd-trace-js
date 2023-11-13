'use strict'

const log = require('../../log')

const logs = new Map()

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

const logCollector = {
  add (logEntry) {
    try {
      if (!isValid(logEntry)) return false

      // NOTE: should errors have higher priority? and discard log entries with lower priority?
      if (logs.size >= maxEntries) {
        overflowedCount++
        return
      }

      const hash = createHash(logEntry)
      if (!logs.has(hash)) {
        logs.set(hash, logEntry)
        return true
      }
    } catch (e) {
      log.error(`Unable to add log to logCollector: ${e.message}`)
    }
    return false
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
