'use strict'

const { NOSQL_MONGODB_INJECTION } = require('../vulnerabilities')
const { getRanges, addSecureMark } = require('../taint-tracking/operations')
const { getNodeModulesPaths } = require('../path-line')
const { storage } = require('../../../../../datadog-core')
const { getIastContext } = require('../iast-context')
const { HTTP_REQUEST_PARAMETER, HTTP_REQUEST_BODY } = require('../taint-tracking/source-types')
const { NOSQL_MONGODB_INJECTION_MARK } = require('../taint-tracking/secure-marks')
const { iterateObjectStrings } = require('../utils')
const InjectionAnalyzer = require('./injection-analyzer')

const EXCLUDED_PATHS_FROM_STACK = getNodeModulesPaths('mongodb', 'mongoose', 'mquery')

const SAFE_OPERATORS = new Set(['$eq', '$gt', '$gte', '$in', '$lt', '$lte', '$ne', '$nin',
  '$exists', '$type', '$mod', '$bitsAllClear', '$bitsAllSet', '$bitsAnyClear', '$bitsAnySet'])

class NosqlInjectionMongodbAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(NOSQL_MONGODB_INJECTION)
    this.sanitizedObjects = new WeakSet()
  }

  onConfigure () {
    this.configureSanitizers()

    // TEMP DEBUG: assign a short id to each filter object to trace duplicate analyses across channels
    let __filterSeq = 0
    const __getFilterId = (filter) => {
      if (!filter || typeof filter !== 'object') return 'n/a'
      if (!filter.__nosqlDbgId) {
        Object.defineProperty(filter, '__nosqlDbgId', { value: ++__filterSeq, enumerable: false })
      }
      return filter.__nosqlDbgId
    }

    // Anything that accesses the storage is context dependent
    const onStart = (channelName) => ({ filters }) => {
      const store = storage('legacy').getStore()
      const ids = filters?.map(__getFilterId).join(',')
      // eslint-disable-next-line no-console
      console.log('[NOSQL DBG] ch=%s nosqlAnalyzed=%s noop=%s filterIds=%s',
        channelName, store?.nosqlAnalyzed, store?.noop, ids)
      if (store && !store.nosqlAnalyzed && filters?.length) {
        for (const filter of filters) {
          this.analyze({ filter }, store)
        }
      }

      return store
    }

    const onStartAndEnterWithStore = (channelName) => (message) => {
      const store = onStart(channelName)(message || {})
      if (store) {
        storage('legacy').enterWith({ ...store, nosqlAnalyzed: true, nosqlParentStore: store })
      }
    }

    // Anything that accesses the storage is context dependent
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const onFinish = () => {
      const store = storage('legacy').getStore()
      if (store?.nosqlParentStore) {
        storage('legacy').enterWith(store.nosqlParentStore)
      }
    }

    this.addSub('datadog:mongodb:collection:filter:start', onStart('mongodb:collection:filter:start'))

    this.addSub('datadog:mongoose:model:filter:start', onStartAndEnterWithStore('mongoose:model:filter:start'))
    this.addSub('datadog:mongoose:model:filter:finish', onFinish)

    this.addSub('datadog:mquery:filter:prepare', onStart('mquery:filter:prepare'))
    this.addSub('tracing:datadog:mquery:filter:start', onStartAndEnterWithStore('mquery:filter:start'))
    this.addSub('tracing:datadog:mquery:filter:asyncEnd', onFinish)

    // TEMP DEBUG: raw subscriptions to bypass IastPlugin/noop checks and verify whether the
    // tracing channels are actually publishing in Node 18 CI.
    const dc = require('dc-polyfill')
    const rawLog = (name) => (message) => {
      const store = storage('legacy').getStore()
      // eslint-disable-next-line no-console
      console.log('[NOSQL DBG RAW] ch=%s nosqlAnalyzed=%s noop=%s hasStore=%s keys=%j',
        name, store?.nosqlAnalyzed, store?.noop, !!store, message && Object.keys(message))
    }

    // TEMP DEBUG: log subscriber state before/after each subscribe on the tracing start channel
    // to understand whether subscriptions are actually registered on the channel mquery publishes on.
    const startCh = dc.channel('tracing:datadog:mquery:filter:start')
    const prepareChDbg = dc.channel('datadog:mquery:filter:prepare')
    // eslint-disable-next-line no-console
    console.log('[NOSQL DBG INIT] nodeVersion=%s startChHas=%s prepareChHas=%s startSubs=%s prepareSubs=%s',
      process.versions.node,
      startCh?.hasSubscribers, prepareChDbg?.hasSubscribers,
      startCh?._subscribers?.length, prepareChDbg?._subscribers?.length)

    startCh.subscribe(rawLog('raw:mquery:filter:start'))
    dc.channel('tracing:datadog:mquery:filter:asyncEnd').subscribe(rawLog('raw:mquery:filter:asyncEnd'))
    dc.channel('tracing:datadog:mquery:filter:end').subscribe(rawLog('raw:mquery:filter:end'))
    dc.channel('tracing:datadog:mquery:filter:error').subscribe(rawLog('raw:mquery:filter:error'))
    prepareChDbg.subscribe(rawLog('raw:mquery:filter:prepare'))

    // eslint-disable-next-line no-console
    console.log('[NOSQL DBG INIT] AFTER SUBSCRIBE startChHas=%s prepareChHas=%s startSubs=%s prepareSubs=%s',
      startCh?.hasSubscribers, prepareChDbg?.hasSubscribers,
      startCh?._subscribers?.length, prepareChDbg?._subscribers?.length)
  }

  configureSanitizers () {
    this.addNotSinkSub('datadog:express-mongo-sanitize:filter:finish', ({ sanitizedProperties, req }) => {
      const store = storage('legacy').getStore()
      const iastContext = getIastContext(store)

      if (iastContext) { // do nothing if we are not in an iast request
        for (const key of sanitizedProperties) {
          iterateObjectStrings(req[key], function (value, levelKeys) {
            if (typeof value === 'string') {
              let parentObj = req[key]
              const levelsLength = levelKeys.length

              for (let i = 0; i < levelsLength; i++) {
                const currentLevelKey = levelKeys[i]

                if (i === levelsLength - 1) {
                  parentObj[currentLevelKey] = addSecureMark(iastContext, value, NOSQL_MONGODB_INJECTION_MARK)
                } else {
                  parentObj = parentObj[currentLevelKey]
                }
              }
            }
          })
        }
      }
    })

    this.addNotSinkSub('datadog:express-mongo-sanitize:sanitize:finish', ({ sanitizedObject }) => {
      const store = storage('legacy').getStore()
      const iastContext = getIastContext(store)

      if (iastContext) { // do nothing if we are not in an iast request
        iterateObjectStrings(sanitizedObject, function (value, levelKeys, parent, lastKey) {
          try {
            parent[lastKey] = addSecureMark(iastContext, value, NOSQL_MONGODB_INJECTION_MARK)
          } catch {
            // if it is a readonly property, do nothing
          }
        })
      }
    })

    this.addNotSinkSub('datadog:mongoose:sanitize-filter:finish', ({ sanitizedObject }) => {
      this.sanitizedObjects.add(sanitizedObject)
    })
  }

  _isVulnerableRange (range, value) {
    const rangeIsWholeValue = range.start === 0 && range.end === value?.length

    if (!rangeIsWholeValue) return false

    const rangeType = range?.iinfo?.type
    return rangeType === HTTP_REQUEST_PARAMETER || rangeType === HTTP_REQUEST_BODY
  }

  _isVulnerable (value, iastContext) {
    if (value?.filter && iastContext) {
      let isVulnerable = false

      if (this.sanitizedObjects.has(value.filter)) {
        return false
      }

      const rangesByKey = {}
      const allRanges = []

      iterateMongodbQueryStrings(value.filter, (val, nextLevelKeys) => {
        let ranges = getRanges(iastContext, val)
        if (ranges?.length === 1) {
          ranges = this._filterSecureRanges(ranges)
          if (!ranges.length) {
            this._incrementSuppressedMetric(iastContext)
            return
          }

          const range = ranges[0]
          if (!this._isVulnerableRange(range, val)) {
            return
          }
          isVulnerable = true

          rangesByKey[nextLevelKeys.join('.')] = ranges
          allRanges.push(range)
        }
      })

      if (isVulnerable) {
        value.rangesToApply = rangesByKey
        value.ranges = allRanges
      }

      return isVulnerable
    }
    return false
  }

  _getEvidence (value, iastContext) {
    return { value: value.filter, rangesToApply: value.rangesToApply, ranges: value.ranges }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS_FROM_STACK
  }
}

function iterateMongodbQueryStrings (target, fn, levelKeys = [], depth = 10, visited = new Set()) {
  if (target !== null && typeof target === 'object') {
    if (visited.has(target)) return

    visited.add(target)

    for (const key of Object.keys(target)) {
      if (SAFE_OPERATORS.has(key)) continue

      const nextLevelKeys = [...levelKeys, key]
      const val = target[key]

      if (typeof val === 'string') {
        fn(val, nextLevelKeys, target, key)
      } else if (depth > 0) {
        iterateMongodbQueryStrings(val, fn, nextLevelKeys, depth - 1, visited)
      }
    }
  }
}

module.exports = new NosqlInjectionMongodbAnalyzer()
