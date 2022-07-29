'use strict'

const OVERHEAD_CONTROLLER_CONTEXT_KEY = 'oce'

const ANALYZE_REQUEST = 'ANALYZE_REQUEST'
const REPORT_VULNERABILITY = 'REPORT_VULNERABILITY'

class Quota {
  constructor (reserved, release) {
    this._acquired = !!reserved
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
    hasQuota: () => {
      const reserved = concurrentRequestTokens > 0
      if (reserved) {
        concurrentRequestTokens--
      }
      return reserved
    },
    release: () => {
      concurrentRequestTokens++
    },
    name: ANALYZE_REQUEST,
    initialTokenBucketSize: 2,
    initRequestContext: (context) => {
      context.isRequestAnalyzed = true
    }
  }
}

let concurrentRequestTokens = LONG_RUNNING_OPERATIONS.ANALYZE_REQUEST.initialTokenBucketSize

const SINGLE_SHOT_OPERATIONS = {
  REPORT_VULNERABILITY: {
    hasQuota: (context) => {
      if (!context.isRequestAnalyzed) return false
      const reserved = context.tokens[REPORT_VULNERABILITY] > 0
      if (reserved) {
        context.tokens[REPORT_VULNERABILITY]--
      }
      return reserved
    },
    name: REPORT_VULNERABILITY,
    initialTokenBucketSize: 2,
    initRequestContext: function (context) {
      context.tokens[REPORT_VULNERABILITY] = this.initialTokenBucketSize
    }
  }
}

function hasQuotaSingleShot (operation, iastContext) {
  if (!iastContext || !iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY]) {
    return false
  }
  return operation.hasQuota(iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY])
}

function hasQuotaLongRunning (operation) {
  const reserved = operation.hasQuota()
  return new Quota(reserved, () => operation.release())
}

function initializeRequestContext (iastContext) {
  const oceContext = {
    tokens: {}
  }

  for (const operation in LONG_RUNNING_OPERATIONS) {
    LONG_RUNNING_OPERATIONS[operation].initRequestContext(oceContext)
  }

  for (const operation in SINGLE_SHOT_OPERATIONS) {
    SINGLE_SHOT_OPERATIONS[operation].initRequestContext(oceContext)
  }

  iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] = oceContext
}

module.exports = {
  OVERHEAD_CONTROLLER_CONTEXT_KEY,
  LONG_RUNNING_OPERATIONS,
  SINGLE_SHOT_OPERATIONS,
  initializeRequestContext,
  hasQuotaSingleShot,
  hasQuotaLongRunning
}
