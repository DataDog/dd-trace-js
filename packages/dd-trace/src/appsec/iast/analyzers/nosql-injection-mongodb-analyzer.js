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

    // Track filter objects already analyzed so mquery doesn't re-analyze the same
    // filter object that mongoose's Model wrapper already handled. Uses object
    // identity: mongoose passes the same filter reference down to mquery internally.
    // This replaces the previous AsyncLocalStorage.enterWith() approach, which leaked
    // the nosqlAnalyzed flag to sibling async contexts in Node.js >= 20.
    const analyzedFilterObjects = new WeakSet()

    const onStart = ({ filters }) => {
      const store = storage('legacy').getStore()
      if (store && filters?.length) {
        for (const filter of filters) {
          if (filter == null || typeof filter !== 'object' || !analyzedFilterObjects.has(filter)) {
            this.analyze({ filter }, store)
          }
        }
      }
      return store
    }

    const onStartAndMarkFilters = (message) => {
      onStart(message || {})
      if (message?.filters) {
        for (const filter of message.filters) {
          if (filter && typeof filter === 'object') {
            analyzedFilterObjects.add(filter)
          }
        }
      }
    }

    this.addSub('datadog:mongodb:collection:filter:start', onStart)

    this.addSub('datadog:mongoose:model:filter:start', onStartAndMarkFilters)
    this.addSub('datadog:mquery:filter:prepare', onStart)
    this.addSub('tracing:datadog:mquery:filter:start', onStartAndMarkFilters)
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
