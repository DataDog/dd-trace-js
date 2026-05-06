'use strict'

const crypto = require('crypto')

const { defaults } = require('../../../config/defaults')

const STRINGIFY_RANGE_KEY = 'DD_' + crypto.randomBytes(20).toString('hex')
const STRINGIFY_SENSITIVE_KEY = STRINGIFY_RANGE_KEY + 'SENSITIVE'
const STRINGIFY_SENSITIVE_NOT_STRING_KEY = STRINGIFY_SENSITIVE_KEY + 'NOTSTRING'

// eslint-disable-next-line @stylistic/max-len
const REGEX_FOR_STRINGIFY_SENSITIVE_NOT_STRING = new RegExp(String.raw`"${STRINGIFY_SENSITIVE_NOT_STRING_KEY}_\d+_([\s\-+0-9.a-zA-Z]*)"`)
const REGEX_FOR_STRINGIFY_SENSITIVE = new RegExp(String.raw`${STRINGIFY_SENSITIVE_KEY}_\d+_(\d+)_`)
const REGEX_FOR_STRINGIFY_RANGE = new RegExp(String.raw`(${STRINGIFY_RANGE_KEY}_\d+_)`)

const sensitiveValueRegex = new RegExp(/** @type {string} */ (defaults['iast.redactionValuePattern']), 'gmi')

function iterateObject (target, fn, levelKeys = [], depth = 10, visited = new Set()) {
  for (const key of Object.keys(target)) {
    const nextLevelKeys = [...levelKeys, key]
    const val = target[key]

    if (typeof val !== 'object' || !visited.has(val)) {
      visited.add(val)
      fn(val, nextLevelKeys, target, key)

      if (val !== null && typeof val === 'object' && depth > 0) {
        iterateObject(val, fn, nextLevelKeys, depth - 1, visited)
      }
    }
  }
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
      } else {
        currentLevelClone[key] = Array.isArray(val) ? [] : {}
      }
    })

    value = JSON.stringify(cloneObj, null, 2)

    if (counter > 0) {
      const segments = []
      let outputLength = 0
      let pos = 0
      const rangeKeyToFind = `${STRINGIFY_RANGE_KEY}`
      let rangeKeyIndex = value.indexOf(rangeKeyToFind)

      while (rangeKeyIndex > -1) {
        let theRest = value.slice(rangeKeyIndex)
        let cleanLength = rangeKeyIndex - pos

        if (theRest.startsWith(STRINGIFY_SENSITIVE_NOT_STRING_KEY)) {
          rangeKeyIndex--
          cleanLength--
          theRest = value.slice(rangeKeyIndex)
          const regexRes = REGEX_FOR_STRINGIFY_SENSITIVE_NOT_STRING.exec(theRest)

          if (regexRes?.index === 0) {
            const matchValue = regexRes[0]
            const originalValue = regexRes[1]
            const start = outputLength + cleanLength

            sensitiveRanges.push({
              start,
              end: start + originalValue.length,
            })
            segments.push(value.slice(pos, rangeKeyIndex), originalValue)
            outputLength += cleanLength + originalValue.length
            pos = rangeKeyIndex + matchValue.length
          } else {
            // can't happen, the only way to this to happen is
            // if the JSON has a value starting with the value of STRINGIFY_SENSITIVE_NOT_STRING_KEY
            segments.push(value.slice(pos, rangeKeyIndex + STRINGIFY_SENSITIVE_NOT_STRING_KEY.length + 1))
            outputLength += cleanLength + STRINGIFY_SENSITIVE_NOT_STRING_KEY.length + 1
            pos = rangeKeyIndex + STRINGIFY_SENSITIVE_NOT_STRING_KEY.length + 1
          }
        } else if (theRest.startsWith(STRINGIFY_SENSITIVE_KEY)) {
          const regexRes = REGEX_FOR_STRINGIFY_SENSITIVE.exec(theRest)
          if (regexRes?.index === 0) {
            const start = outputLength + cleanLength

            sensitiveRanges.push({
              start,
              end: start + Number.parseInt(regexRes[1]),
            })
            segments.push(value.slice(pos, rangeKeyIndex))
            outputLength += cleanLength
            pos = rangeKeyIndex + regexRes[0].length
          } else {
            // can't happen, the only way to this to happen is
            // if the JSON has a value starting with the value of STRINGIFY_SENSITIVE_KEY
            segments.push(value.slice(pos, rangeKeyIndex + STRINGIFY_SENSITIVE_KEY.length))
            outputLength += cleanLength + STRINGIFY_SENSITIVE_KEY.length
            pos = rangeKeyIndex + STRINGIFY_SENSITIVE_KEY.length
          }
        } else {
          const regexRes = REGEX_FOR_STRINGIFY_RANGE.exec(theRest)
          if (regexRes?.index === 0) {
            const start = outputLength + cleanLength
            const rangesId = regexRes[1]

            const updatedRanges = allRanges[rangesId].map(range => ({
              ...range,
              start: range.start + start,
              end: range.end + start,
            }))
            ranges.push(...updatedRanges)

            segments.push(value.slice(pos, rangeKeyIndex))
            outputLength += cleanLength
            pos = rangeKeyIndex + regexRes[0].length
          } else {
            // can't happen, the only way to this to happen is
            // if the JSON has a value starting with the value of STRINGIFY_RANGE_KEY
            segments.push(value.slice(pos, rangeKeyIndex + STRINGIFY_SENSITIVE_KEY.length))
            outputLength += cleanLength + STRINGIFY_SENSITIVE_KEY.length
            pos = rangeKeyIndex + STRINGIFY_SENSITIVE_KEY.length
          }
        }

        rangeKeyIndex = value.indexOf(rangeKeyToFind, pos)
      }

      segments.push(value.slice(pos))
      value = segments.join('')
    }
  } else {
    value = JSON.stringify(obj, null, 2)
  }

  return { value, ranges, sensitiveRanges }
}

module.exports = { stringifyWithRanges }
