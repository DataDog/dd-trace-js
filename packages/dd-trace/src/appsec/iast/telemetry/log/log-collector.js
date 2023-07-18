'use strict'

const log = require('../../../../log')

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
  if (!logEntry) return 0

  const prime = 31
  let result = ((!logEntry.level) ? 0 : hashCode(logEntry.level))
  result = (((prime * result) | 0) + ((!logEntry.message) ? 0 : hashCode(logEntry.message))) | 0

  // NOTE: tags are not used at the moment
  // result = (((prime * result) | 0) + ((!logEntry.tags) ? 0 : hashCode(logEntry.tags))) | 0
  result = (((prime * result) | 0) + ((!logEntry.stack_trace) ? 0 : hashCode(logEntry.stack_trace))) | 0
  return result
}

function newLogEntry (message, level, tags) {
  return {
    message,
    level,
    tags
  }
}

function isValid (logEntry) {
  return logEntry && logEntry.level && logEntry.message
}

const logCollector = {
  add (logEntry) {
    try {
      if (!isValid(logEntry)) {
        log.info('IAST log collector discarding invalid log')
        return
      }

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

    const drained = []
    drained.push(...logs.values())

    if (overflowedCount > 0) {
      drained.push(newLogEntry(`Omitted ${overflowedCount} entries due to overflowing`, 'ERROR'))
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
