'use strict'

const constants = require('./constants')
const log = require('./log')
const ERROR_MESSAGE = constants.ERROR_MESSAGE
const ERROR_STACK = constants.ERROR_STACK
const ERROR_TYPE = constants.ERROR_TYPE
const DD_EMPTY_USER_TAG = constants.DD_EMPTY_USER_TAG

const otelTagMap = {
  'deployment.environment': 'env',
  'service.name': 'service',
  'service.version': 'version'
}

// don't allow these tags to be empty
const skipEmptyString = new Set(['env', 'service', 'version'])

function add (carrier, keyValuePairs, parseOtelTags = false, parseSpaceSeparatedTags = false) {
  if (!carrier || !keyValuePairs) return

  if (Array.isArray(keyValuePairs)) {
    return keyValuePairs.forEach(tags => add(carrier, tags, parseOtelTags, parseSpaceSeparatedTags))
  }
  try {
    if (typeof keyValuePairs === 'string') {
      let segments
      if (parseSpaceSeparatedTags) {
        const separator = keyValuePairs.includes(',') ? ',' : ' '
        segments =
        separator === ' '
          ? keyValuePairs.split(/\s+/)
          : keyValuePairs.split(separator)
      } else {
        segments = keyValuePairs.split(',')
      }

      for (const segment of segments) {
        const separatorIndex = parseOtelTags ? segment.indexOf('=') : segment.indexOf(':')
        if (separatorIndex === -1) {
          if (parseSpaceSeparatedTags) {
            carrier[segment.trim()] = skipEmptyString.has(segment.trim()) ? '' : DD_EMPTY_USER_TAG
          }
          continue
        }

        let key = segment.slice(0, separatorIndex)
        const value = segment.slice(separatorIndex + 1)

        if (parseOtelTags && key in otelTagMap) {
          key = otelTagMap[key]
        }

        let trimmedValue = value.trim()

        if (trimmedValue === '') {
          trimmedValue = skipEmptyString.has(key.trim()) ? '' : DD_EMPTY_USER_TAG
        }

        carrier[key.trim()] = trimmedValue
      }
    } else {
      // HACK: to ensure otel.recordException does not influence trace.error
      if (ERROR_MESSAGE in keyValuePairs || ERROR_STACK in keyValuePairs || ERROR_TYPE in keyValuePairs) {
        if (!('doNotSetTraceError' in keyValuePairs)) {
          carrier.setTraceError = true
        }
      }
      Object.assign(carrier, keyValuePairs)
    }
  } catch (e) {
    log.error('Error adding tags', e)
  }
}

module.exports = { add }
