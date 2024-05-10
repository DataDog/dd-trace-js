'use strict'

const crypto = require('crypto')
const { DEFAULT_IAST_REDACTION_VALUE_PATTERN } = require('./evidence-redaction/sensitive-regex')

const STRINGIFY_RANGE_KEY = 'DD_' + crypto.randomBytes(20).toString('hex')
const STRINGIFY_SENSITIVE_KEY = STRINGIFY_RANGE_KEY + 'SENSITIVE'
const STRINGIFY_SENSITIVE_NOT_STRING_KEY = STRINGIFY_SENSITIVE_KEY + 'NOTSTRING'

// eslint-disable-next-line max-len
const KEYS_REGEX_WITH_SENSITIVE_RANGES = new RegExp(`(?:"(${STRINGIFY_RANGE_KEY}_\\d+_))|(?:"(${STRINGIFY_SENSITIVE_KEY}_\\d+_(\\d+)_))|("${STRINGIFY_SENSITIVE_NOT_STRING_KEY}_\\d+_([\\s0-9.a-zA-Z]*)")`, 'gm')
const KEYS_REGEX_WITHOUT_SENSITIVE_RANGES = new RegExp(`"(${STRINGIFY_RANGE_KEY}_\\d+_)`, 'gm')

const sensitiveValueRegex = new RegExp(DEFAULT_IAST_REDACTION_VALUE_PATTERN, 'gmi')

function iterateObject (target, fn, levelKeys = [], depth = 10, visited = new Set()) {
  Object.keys(target).forEach((key) => {
    const nextLevelKeys = [...levelKeys, key]
    const val = target[key]

    if (typeof val !== 'object' || !visited.has(val)) {
      visited.add(val)
      fn(val, nextLevelKeys, target, key)

      if (val !== null && typeof val === 'object' && depth > 0) {
        iterateObject(val, fn, nextLevelKeys, depth - 1, visited)
      }
    }
  })
}

function stringifyWithRanges (obj, objRanges, loadSensitiveRanges = false) {
  let value
  const ranges = []
  const sensitiveRanges = []
  objRanges = objRanges || {}

  if (objRanges || loadSensitiveRanges) {
    const cloneObj = Array.isArray(obj) ? [] : {}
    let counter = 0
    const allRanges = {}
    const sensitiveKeysMapping = {}

    iterateObject(obj, (val, levelKeys, parent, key) => {
      let currentLevelClone = cloneObj
      for (let i = 0; i < levelKeys.length - 1; i++) {
        let levelKey = levelKeys[i]

        if (!currentLevelClone[levelKey]) {
          const sensitiveKey = sensitiveKeysMapping[levelKey]
          if (currentLevelClone[sensitiveKey]) {
            levelKey = sensitiveKey
          }
        }

        currentLevelClone = currentLevelClone[levelKey]
      }

      if (loadSensitiveRanges) {
        const sensitiveKey = sensitiveKeysMapping[key]
        if (sensitiveKey) {
          key = sensitiveKey
        } else {
          sensitiveValueRegex.lastIndex = 0

          if (sensitiveValueRegex.test(key)) {
            const current = counter++
            const id = `${STRINGIFY_SENSITIVE_KEY}_${current}_${key.length}_`
            key = `${id}${key}`
          }
        }
      }

      if (typeof val === 'string') {
        const ranges = objRanges[levelKeys.join('.')]
        if (ranges) {
          const current = counter++
          const id = `${STRINGIFY_RANGE_KEY}_${current}_`

          allRanges[id] = ranges
          currentLevelClone[key] = `${id}${val}`
        } else {
          currentLevelClone[key] = val
        }
        if (loadSensitiveRanges) {
          const current = counter++
          const id = `${STRINGIFY_SENSITIVE_KEY}_${current}_${val.length}_`

          currentLevelClone[key] = `${id}${currentLevelClone[key]}`
        }
      } else if (typeof val !== 'object' || val === null) {
        if (loadSensitiveRanges) {
          const current = counter++
          const id = `${STRINGIFY_SENSITIVE_NOT_STRING_KEY}_${current}_`

          // this is special, in the final string we should modify "key_value_[null|false|true]..."
          // by null|false|..... ignoring the beginning and ending quotes
          currentLevelClone[key] = id + val
        } else {
          currentLevelClone[key] = val
        }
      } else if (Array.isArray(val)) {
        currentLevelClone[key] = []
      } else {
        currentLevelClone[key] = {}
      }
    })

    value = JSON.stringify(cloneObj, null, 2)

    if (counter > 0) {
      let keysRegex
      if (loadSensitiveRanges) {
        keysRegex = KEYS_REGEX_WITH_SENSITIVE_RANGES
      } else {
        keysRegex = KEYS_REGEX_WITHOUT_SENSITIVE_RANGES
      }
      keysRegex.lastIndex = 0

      let regexRes = keysRegex.exec(value)
      while (regexRes) {
        const offset = regexRes.index + 1 // +1 to increase the " char

        if (regexRes[1]) {
          // is a range
          const rangesId = regexRes[1]
          value = value.replace(rangesId, '')

          const updatedRanges = allRanges[rangesId].map(range => {
            return {
              ...range,
              start: range.start + offset,
              end: range.end + offset
            }
          })

          ranges.push(...updatedRanges)
        } else if (regexRes[2]) {
          // is a sensitive string literal
          const sensitiveId = regexRes[2]

          sensitiveRanges.push({
            start: offset,
            end: offset + parseInt(regexRes[3])
          })

          value = value.replace(sensitiveId, '')
        } else if (regexRes[4]) {
          // is a sensitive value (number, null, false, ...)
          const sensitiveId = regexRes[4]
          const originalValue = regexRes[5]

          sensitiveRanges.push({
            start: regexRes.index,
            end: regexRes.index + originalValue.length
          })

          value = value.replace(sensitiveId, originalValue)
        }

        keysRegex.lastIndex = 0
        regexRes = keysRegex.exec(value)
      }
    }
  } else {
    value = JSON.stringify(obj, null, 2)
  }

  return { value, ranges, sensitiveRanges }
}

module.exports = { stringifyWithRanges }
