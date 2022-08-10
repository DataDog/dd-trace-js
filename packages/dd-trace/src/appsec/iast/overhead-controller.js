'use strict'
const Scheduler = require('../../exporters/scheduler')

const OVERHEAD_CONTROLLER_CONTEXT_KEY = 'oce'
const GLOBAL_CONTEXT_RESET_INTERVAL = 30000

const REPORT_VULNERABILITY = 'REPORT_VULNERABILITY'

const GLOBAL_OCE_CONTEXT = {}
let oceConfig = {}
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
      return typeof oceConfig.maxContextOperations === 'number' ? oceConfig.maxContextOperations : 2
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

const _globalContextResetScheduler = new Scheduler(_resetGlobalContext, GLOBAL_CONTEXT_RESET_INTERVAL)
_resetGlobalContext()

function acquireRequest (rootSpan) {
  if (availableRequest > 0) {
    const sampling = oceConfig && typeof oceConfig.requestSampling === 'number'
      ? oceConfig.requestSampling : 30
    if (rootSpan.context().toSpanId().slice(-2) <= sampling) {
      availableRequest--
      return true
    }
  }
  return false
}

function releaseRequest () {
  if (availableRequest < oceConfig.maxConcurrentRequest) {
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

function startGlobalContextResetScheduler () {
  _globalContextResetScheduler.start()
}

function stopGlobalContextResetScheduler () {
  _globalContextResetScheduler.stop()
}

function configureOCE (cfg) {
  oceConfig = cfg
  availableRequest = oceConfig.maxConcurrentRequest
}

module.exports = {
  OVERHEAD_CONTROLLER_CONTEXT_KEY,
  OPERATIONS,
  _resetGlobalContext,
  startGlobalContextResetScheduler,
  stopGlobalContextResetScheduler,
  initializeRequestContext,
  hasQuota,
  acquireRequest,
  releaseRequest,
  configureOCE
}
