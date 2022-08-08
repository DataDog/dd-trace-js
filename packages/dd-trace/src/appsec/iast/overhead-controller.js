'use strict'

const OVERHEAD_CONTROLLER_CONTEXT_KEY = 'oce'
const GLOBAL_CONTEXT_RESET_INTERVAL = 30000

const REPORT_VULNERABILITY = 'REPORT_VULNERABILITY'

let globalContextResetInterval
const GLOBAL_OCE_CONTEXT = {}

const OPERATIONS = {
  REPORT_VULNERABILITY: {
    hasQuota: (context) => {
      const reserved = context && context.tokens[REPORT_VULNERABILITY] > 0
      if (reserved) {
        context.tokens[REPORT_VULNERABILITY]--
      }
      return reserved
    },
    name: REPORT_VULNERABILITY,
    initialTokenBucketSize: 2,
    initContext: function (context) {
      context.tokens[REPORT_VULNERABILITY] = this.initialTokenBucketSize
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

function acquireRequest (rootSpan) {
  return (rootSpan.context().toSpanId() % 3) === 0
}

function hasQuota (operation, iastContext) {
  const oceContext = _getContext(iastContext)
  return operation.hasQuota(oceContext)
}

function initializeRequestContext (iastContext) {
  iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] = _getNewContext()
}

function _resetGlobalContext () {
  Object.assign(GLOBAL_OCE_CONTEXT, _getNewContext())
}

function startGlobalContextResetInterval () {
  if (!globalContextResetInterval) {
    globalContextResetInterval = setInterval(() => {
      _resetGlobalContext()
    }, GLOBAL_CONTEXT_RESET_INTERVAL)
    globalContextResetInterval.unref()
  }
}

function stopGlobalContextResetInterval () {
  if (globalContextResetInterval) {
    globalContextResetInterval = clearInterval(globalContextResetInterval)
  }
}

module.exports = {
  OVERHEAD_CONTROLLER_CONTEXT_KEY,
  OPERATIONS,
  startGlobalContextResetInterval,
  stopGlobalContextResetInterval,
  _resetGlobalContext,
  initializeRequestContext,
  hasQuota,
  acquireRequest
}
