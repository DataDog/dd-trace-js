'use strict'

const { LRUCache } = require('lru-cache')
const web = require('../../plugins/util/web')
const vulnerabilities = require('./vulnerabilities')

const OVERHEAD_CONTROLLER_CONTEXT_KEY = 'oce'
const REPORT_VULNERABILITY = 'REPORT_VULNERABILITY'
const INTERVAL_RESET_GLOBAL_CONTEXT = 60 * 1000

const GLOBAL_OCE_CONTEXT = {}

let resetGlobalContextInterval
let config = {}
let availableRequest = 0

const globalRouteMap = new LRUCache({ max: 4096 })
let vulnerabilitiesSize = 0
const vulnerabilityIndexes = Object.values(vulnerabilities).reduce((obj, item, index) => {
  obj[item] = index
  vulnerabilitiesSize++
  return obj
}, {})

function newCountersArray () {
  return (new Array(vulnerabilitiesSize)).fill(0)
}

function copyFromGlobalMap (route) {
  const vulnerabilityCounters = globalRouteMap.get(route)
  return vulnerabilityCounters ? [...vulnerabilityCounters] : newCountersArray()
}

// for testing purposes
function clearGlobalRouteMap () {
  globalRouteMap.clear()
}

const OPERATIONS = {
  REPORT_VULNERABILITY: {
    hasQuota: (context, vulnerabilityType) => {
      const reserved = context?.tokens?.[REPORT_VULNERABILITY] > 0
      if (reserved && context.route != null) {
        let copyMap = context.copyMap
        let localMap = context.localMap

        if (context.loadedRoute !== context.route) {
          context.copyMaps ??= {}
          context.copyMaps[context.route] ??= copyFromGlobalMap(context.route)
          context.localMaps ??= {}
          context.localMaps[context.route] ??= newCountersArray()
          context.loadedRoute = context.route
          copyMap = context.copyMaps[context.route]
          localMap = context.localMaps[context.route]
          context.copyMap = copyMap
          context.localMap = localMap
        }

        const vulnerabilityIndex = vulnerabilityIndexes[vulnerabilityType]
        const counter = localMap[vulnerabilityIndex]++
        const storedCounter = copyMap[vulnerabilityIndex]

        if (counter < storedCounter) {
          return false
        }
      }

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
  if (iastContext?.[OVERHEAD_CONTROLLER_CONTEXT_KEY]) {
    const oceContext = iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY]
    if (!oceContext.webContext) {
      oceContext.webContext = web.getContext(iastContext.req)
      oceContext.method = iastContext.req?.method
    }

    const currentPaths = oceContext.webContext?.paths
    if (currentPaths !== oceContext.paths || !oceContext.route) {
      oceContext.paths = currentPaths
      oceContext.route = '#' + oceContext.method + '#' + (currentPaths?.join('') || '')
    }

    return iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY]
  }
  return GLOBAL_OCE_CONTEXT
}

function consolidateVulnerabilities (iastContext) {
  const context = _getContext(iastContext)
  if (!context.localMaps) return

  const reserved = context.tokens?.[REPORT_VULNERABILITY] > 0

  if (reserved) { // still a bit of budget available
    Object.keys(context.localMaps).forEach(route => {
      globalRouteMap.set(route, newCountersArray())
    })
  } else {
    Object.keys(context.localMaps).forEach(route => {
      const localMap = context.localMaps[route]
      const globalMap = globalRouteMap.get(route)
      if (!globalMap) {
        globalRouteMap.set(route, localMap)
        return
      }

      for (let i = 0; i < vulnerabilitiesSize; i++) {
        if (localMap[i] > globalMap[i]) {
          globalMap[i] = localMap[i]
        }
      }
    })
  }
}

function _resetGlobalContext () {
  Object.assign(GLOBAL_OCE_CONTEXT, _getNewContext())
}

function acquireRequest (rootSpan) {
  if (availableRequest > 0 && rootSpan) {
    const sampling = config && typeof config.requestSampling === 'number'
      ? config.requestSampling
      : 30
    if (rootSpan.context().toSpanId().slice(-2) <= sampling) {
      availableRequest--
      return true
    }
  }
  return false
}

function releaseRequest () {
  if (availableRequest < config.maxConcurrentRequests) {
    availableRequest++
  }
}

function hasQuota (operation, iastContext, vulnerabilityType) {
  const oceContext = _getContext(iastContext)
  return operation.hasQuota(oceContext, vulnerabilityType)
}

function initializeRequestContext (iastContext) {
  if (iastContext) iastContext[OVERHEAD_CONTROLLER_CONTEXT_KEY] = _getNewContext()
}

function configure (cfg) {
  config = cfg
  availableRequest = config.maxConcurrentRequests
}

function startGlobalContext () {
  if (resetGlobalContextInterval) return
  _resetGlobalContext()
  resetGlobalContextInterval = setInterval(() => {
    _resetGlobalContext()
  }, INTERVAL_RESET_GLOBAL_CONTEXT)
  resetGlobalContextInterval.unref?.()
}

function finishGlobalContext () {
  if (resetGlobalContextInterval) {
    clearInterval(resetGlobalContextInterval)
    resetGlobalContextInterval = null
  }
}

module.exports = {
  OVERHEAD_CONTROLLER_CONTEXT_KEY,
  OPERATIONS,
  startGlobalContext,
  finishGlobalContext,
  _resetGlobalContext,
  initializeRequestContext,
  hasQuota,
  acquireRequest,
  releaseRequest,
  configure,
  consolidateVulnerabilities,
  clearGlobalRouteMap
}
