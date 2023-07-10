'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { NO_SQL_MONGODB_INJECTION } = require('../vulnerabilities')
const { isTainted, getRanges } = require('../taint-tracking/operations')
const { getNodeModulesPaths } = require('../path-line')

const EXCLUDED_PATHS_FROM_STACK = getNodeModulesPaths('mongodb')

function iterateObjectStrings (target, fullKey, fn, depth) {
  if (target && typeof target === 'object') {
    Object.keys(target).forEach((key) => {
      const levelKey = fullKey ? `${fullKey}.${key}` : key
      const val = target[key]
      if (typeof val === 'string') {
        fn(val, levelKey)
      } else if (depth > 0) {
        iterateObjectStrings(val, levelKey, fn, depth - 1)
      }
    })
  }
}

class NosqlInjectionMongodbAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(NO_SQL_MONGODB_INJECTION)

    this.addSub('datadog:mongodb:collection:filter:start', ({ filters, methodName }) => {
      if (filters && filters.length) {
        filters.forEach(filter => {
          this.analyze(filter)
        })
      }
    })
  }

  _isVulnerable (value, iastContext) {
    if (value && iastContext) {
      let someTainted = false
      iterateObjectStrings(value, null, (val) => {
        if (isTainted(iastContext, val)) {
          // TODO getRanges and check secure marks
          someTainted = true
        }
      })
      return someTainted
    }
    return false
  }

  _getEvidence (value, iastContext) {
    return { value: JSON.stringify(value) }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS_FROM_STACK
  }
}

module.exports = new NosqlInjectionMongodbAnalyzer()
