'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { NO_SQL_MONGODB_INJECTION } = require('../vulnerabilities')
const { getRanges, addSecureMark } = require('../taint-tracking/operations')
const { getNodeModulesPaths } = require('../path-line')
const { getNextSecureMark } = require('../taint-tracking/secure-marks-generator')
const { storage } = require('../../../../../datadog-core')
const { getIastContext } = require('../iast-context')

const EXCLUDED_PATHS_FROM_STACK = getNodeModulesPaths('mongodb', 'mongoose')
const MONGODB_NOSQL_SECURE_MARK = getNextSecureMark()
function iterateObjectStrings (target, fn, levelKeys = [], depth = 50) {
  if (target && typeof target === 'object') {
    Object.keys(target).forEach((key) => {
      const nextLevelKeys = [...levelKeys, key]
      const val = target[key]
      if (typeof val === 'string') {
        fn(val, nextLevelKeys, target, key)
      } else if (depth > 0) {
        iterateObjectStrings(val, fn, nextLevelKeys, depth - 1)
      }
    })
  }
}

class NosqlInjectionMongodbAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(NO_SQL_MONGODB_INJECTION)
  }
  onConfigure () {
    this.configureSanitizers()

    this.addSub('datadog:mongodb:collection:filter:start', ({ filters, methodName }) => {
      if (filters && filters.length) {
        filters.forEach(filter => {
          this.analyze(filter)
        })
      }
    })
  }

  configureSanitizers () {
    // TODO => this is not a sinkpoint, speak to Igor about how to prevent to add the sinkpoint
    this.addSub('datadog:express-mongo-sanitize:filter:finish', ({ sanitizedProperties, req }) => {
      const store = storage.getStore()
      const iastContext = getIastContext(store)

      if (iastContext) { // do nothing if we are not in an iast request
        sanitizedProperties.forEach(key => {
          iterateObjectStrings(req[key], function (value, levelKeys) {
            if (typeof value === 'string') {
              let parentObj = req[key]
              const levelsLength = levelKeys.length

              for (let i = 0; i < levelsLength; i++) {
                const currentLevelKey = levelKeys[i]
                if (i === levelsLength - 1) {
                  parentObj[currentLevelKey] = addSecureMark(iastContext, value, MONGODB_NOSQL_SECURE_MARK)
                } else {
                  parentObj = parentObj[currentLevelKey]
                }
              }
            }
          })
        })
      }
    })

    // TODO => this is not a sinkpoint, speak to Igor about how to prevent to add the sinkpoint
    this.addSub('datadog:express-mongo-sanitize:sanitize:finish', ({ sanitizedObject }) => {
      const store = storage.getStore()
      const iastContext = getIastContext(store)

      if (iastContext) { // do nothing if we are not in an iast request
        iterateObjectStrings(sanitizedObject, function (value, levelKeys, parent, lastKey) {
          try {
            parent[lastKey] = addSecureMark(iastContext, value, MONGODB_NOSQL_SECURE_MARK)
          } catch {
            // if it is a readonly property, do nothing
          }
        })
      }
    })
  }

  _isVulnerable (value, iastContext) {
    if (value && iastContext) {
      let isVulnerable = false

      iterateObjectStrings(value, val => {
        const ranges = getRanges(iastContext, val)

        if (ranges && ranges.length) {
          for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i]

            if ((range.secureMarks & MONGODB_NOSQL_SECURE_MARK) !== MONGODB_NOSQL_SECURE_MARK) {
              isVulnerable = true
              break
            }
          }
        }
      })

      return isVulnerable
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
module.exports.MONGODB_NOSQL_SECURE_MARK = MONGODB_NOSQL_SECURE_MARK
