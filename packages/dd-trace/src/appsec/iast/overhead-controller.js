'use strict'

const OVERHEAD_CONTROLLER_CONTEXT_KEY = 'oce'

const ANALYZE_REQUEST = 'ANALYZE_REQUEST'
const REPORT_VULNERABILITY = 'REPORT_VULNERABILITY'

class Quota {
  constructor (reserved, release) {
    this._acquired = reserved
    this._operationRelease = release
    this._released = false
  }

  isAcquired () {
    return this._acquired
  }

  release () {
    if (this._acquired && !this._released) {
      this._operationRelease()
      this._released = true
    }
  }
}

const LONG_RUNNING_OPERATIONS = {
  ANALYZE_REQUEST: {
    hasQuota: (context) => {
      const reserved = concurrentRequestTokens > 0
      context.isRequestAnalyzed = reserved
      if (reserved) {
        concurrentRequestTokens--
      }
      return reserved
    },
    release: () => {
      concurrentRequestTokens++
    },
    name: ANALYZE_REQUEST,
    initialTokenBucketSize: 2
  }
}

let concurrentRequestTokens = LONG_RUNNING_OPERATIONS.ANALYZE_REQUEST.initialTokenBucketSize

const SINGLE_SHOT_OPERATIONS = {
  REPORT_VULNERABILITY: {
    hasQuota: (context) => {
      if (!context.isRequestAnalyzed) return false
      const reserved = !!context.tokens[REPORT_VULNERABILITY] && context.tokens[REPORT_VULNERABILITY] > 0
      if (reserved) {
        context.tokens[REPORT_VULNERABILITY]--
      }
      return reserved
    },
    name: REPORT_VULNERABILITY,
    initialTokenBucketSize: 2
  }
}

function hasQuotaSingleShot (operation, iastContext) {
  iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] = iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] || _initializeContext()
  return operation.hasQuota(iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY])
}

function hasQuotaLongRunning (operation, iastContext) {
  iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] = iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] || _initializeContext()
  const reserved = operation.hasQuota(iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY])
  return new Quota(reserved, () => operation.release(iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY]))
}

function _initializeContext () {
  return {
    tokens: {
      [REPORT_VULNERABILITY]: SINGLE_SHOT_OPERATIONS[REPORT_VULNERABILITY].initialTokenBucketSize
    }
  }
}

module.exports = {
  LONG_RUNNING_OPERATIONS,
  SINGLE_SHOT_OPERATIONS,
  hasQuotaSingleShot,
  hasQuotaLongRunning
}
