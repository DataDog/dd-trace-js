'use strict'

const crypto = require('crypto')

const InjectionAnalyzer = require('./injection-analyzer')
const { NOSQL_MONGODB_INJECTION } = require('../vulnerabilities')
const { getRanges, addSecureMark } = require('../taint-tracking/operations')
const { getNodeModulesPaths } = require('../path-line')
const { getNextSecureMark } = require('../taint-tracking/secure-marks-generator')
const { storage } = require('../../../../../datadog-core')
const { getIastContext } = require('../iast-context')

const EXCLUDED_PATHS_FROM_STACK = getNodeModulesPaths('mongodb', 'mongoose')
const MONGODB_NOSQL_SECURE_MARK = getNextSecureMark()

const STRINGIFY_RANGE_KEY = 'DD_' + crypto.randomBytes(20).toString('hex')

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
    super(NOSQL_MONGODB_INJECTION)
    this.sanitizedObjects = new WeakSet()
  }
  onConfigure () {
    this.configureSanitizers()

    this.addSub('datadog:mongodb:collection:filter:start', ({ filters }) => {
      const store = storage.getStore()
      if (store && !store.nosqlAnalyzed && filters && filters.length) {
        filters.forEach(filter => {
          this.analyze({ filter }, store)
        })
      }
    })

    this.addSub('datadog:mongoose:model:filter:start', ({ filters }) => {
      const store = storage.getStore()
      if (filters && filters.length) {
        filters.forEach(filter => {
          this.analyze({ filter }, store)
        })
      }

      storage.enterWith({ ...store, nosqlAnalyzed: true, mongooseParentStore: store })
    })

    this.addSub('datadog:mongoose:model:filter:finish', ({ filters }) => {
      const store = storage.getStore()
      if (store && store.mongooseParentStore) {
        storage.enterWith(store.mongooseParentStore)
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

    this.addSub('datadog:mongoose:sanitize-filter:finish', ({ sanitizedObject }) => {
      this.sanitizedObjects.add(sanitizedObject)
    })
  }

  _isVulnerable (value, iastContext) {
    if (value && value.filter && iastContext) {
      let isVulnerable = false

      if (this.sanitizedObjects.has(value.filter)) {
        return false
      }

      const allRanges = {}
      let counter = 0
      let filterString = JSON.stringify(value.filter, function (key, val) {
        if (typeof val === 'string') {
          const ranges = getRanges(iastContext, val)
          if (ranges && ranges.length) {
            const filteredRanges = []
            for (let i = 0; i < ranges.length; i++) {
              const range = ranges[i]

              if ((range.secureMarks & MONGODB_NOSQL_SECURE_MARK) !== MONGODB_NOSQL_SECURE_MARK) {
                isVulnerable = true
                filteredRanges.push(range)
              }
            }

            if (filteredRanges.length > 0) {
              const current = counter++
              const id = `${STRINGIFY_RANGE_KEY}_${current}_`
              allRanges[id] = filteredRanges
              return `${id}${val}`
            }
          }
        }
        return val
      }, 2)

      if (isVulnerable) {
        const keysRegex = new RegExp(`"(${STRINGIFY_RANGE_KEY}_\\d+_)`, 'gm')
        const ranges = []
        let regexRes = keysRegex.exec(filterString)
        while (regexRes) {
          const offset = regexRes.index + 1 // +1 to increase the " char
          const rangesId = regexRes[1]
          filterString = filterString.replace(rangesId, '')
          const updatedRanges = allRanges[rangesId].map(range => {
            return {
              ...range,
              start: range.start + offset,
              end: range.end + offset
            }
          })
          ranges.push(...updatedRanges)
          keysRegex.lastIndex = 0
          regexRes = keysRegex.exec(filterString)
        }
        value.filterString = filterString
        value.ranges = ranges
      }
      return isVulnerable
    }
    return false
  }

  _getEvidence (value, iastContext) {
    return { value: value.filterString, ranges: value.ranges }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS_FROM_STACK
  }
}

module.exports = new NosqlInjectionMongodbAnalyzer()
module.exports.MONGODB_NOSQL_SECURE_MARK = MONGODB_NOSQL_SECURE_MARK
