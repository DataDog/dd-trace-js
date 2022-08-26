'use strict'

const OVERHEAD_CONTROLLER_CONTEXT_KEY = 'oce'
const REPORT_VULNERABILITY = 'REPORT_VULNERABILITY'

const GLOBAL_OCE_CONTEXT = {}
let config = {}
let availableRequest = 0
const OPERATIONS = {
  REPORT_VULNERABILITY: {
    hasQuota: (context) => {
      const reserved = context && context.tokens && context.tokens[REPORT_VULNERABILITY] > 0
      if (reserved) {
        context.tokens[REPORT_VULNERABILITY]--
      }
      return reserved
    },
    name: REPORT_VULNERABILITY,
    initialTokenBucketSize () {
      return typeof config.maxContextOperations === 'number' ? config.maxContextOperations : 2
    },
    initContext: function (context) {
      context.tokens[REPORT_VULNERABILITY] = this.initialTokenBucketSize()
    }
  }
}

function _getNewContext () {
  const oceContext = {
    tokens: {}
  }

  for (const operation in OPERATIONS) {
    OPERATIONS[operation].initContext(oceContext)
  }

  return oceContext
}

function _getContext (iastContext) {
  if (iastContext && iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY]) {
    return iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY]
  }
  return GLOBAL_OCE_CONTEXT
}

function _resetGlobalContext () {
  Object.assign(GLOBAL_OCE_CONTEXT, _getNewContext())
}

function acquireRequest (rootSpan) {
  if (availableRequest > 0) {
    const sampling = config && typeof config.requestSampling === 'number'
      ? config.requestSampling : 30
    if (rootSpan.context().toSpanId().slice(-2) <= sampling) {
      availableRequest--
      return true
    }
  }
  return false
}

function releaseRequest () {
  if (availableRequest < config.maxConcurrentRequest) {
    availableRequest++
  }
}

function hasQuota (operation, iastContext) {
  const oceContext = _getContext(iastContext)
  return operation.hasQuota(oceContext)
}

function initializeRequestContext (iastContext) {
  if (iastContext) iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] = _getNewContext()
}

function configure (cfg) {
  config = cfg
  availableRequest = config.maxConcurrentRequest
}

_resetGlobalContext()

module.exports = {
  OVERHEAD_CONTROLLER_CONTEXT_KEY,
  OPERATIONS,
  _resetGlobalContext,
  initializeRequestContext,
  hasQuota,
  acquireRequest,
  releaseRequest,
  configure
}
