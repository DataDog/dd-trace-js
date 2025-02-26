'use strict'

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, DD_EMPTY_USER_TAG } = require('./constants')
const log = require('./log')

const otelTagMap = {
  'deployment.environment': 'env',
  'service.name': 'service',
  'service.version': 'version'
}

// don't allow these tags to be empty
const skipEmptyString = new Set(['env', 'service', 'version'])

function processObjectCarrier (carrier, keyValuePairs) {
  // HACK: Ensure otel.recordException does not influence trace.error
  if (
    ERROR_MESSAGE in keyValuePairs ||
    ERROR_STACK in keyValuePairs ||
    ERROR_TYPE in keyValuePairs
  ) {
    if (!('doNotSetTraceError' in keyValuePairs)) {
      carrier.setTraceError = true
    }
  }
  Object.assign(carrier, keyValuePairs)
}

function processStringTags (carrier, tagStr, parseOtelTags, spaceSeparatedMode = false) {
  let segments
  if (spaceSeparatedMode) {
    segments = tagStr.split(/\s+/)
  } else {
    segments = tagStr.split(',')
  }

  for (const segment of segments) {
    const trimmedSegment = segment.trim()
    if (!trimmedSegment) continue

    const separatorIndex = parseOtelTags
      ? trimmedSegment.indexOf('=')
      : trimmedSegment.indexOf(':')

    if (separatorIndex === -1) {
      if (spaceSeparatedMode) continue
      carrier[trimmedSegment] = skipEmptyString.has(trimmedSegment)
        ? ''
        : DD_EMPTY_USER_TAG
      continue
    }

    let key = trimmedSegment.slice(0, separatorIndex).trim()
    let value = trimmedSegment.slice(separatorIndex + 1).trim()

    if (parseOtelTags && key in otelTagMap) {
      key = otelTagMap[key]
    }

    if (spaceSeparatedMode && value === '') {
      value = skipEmptyString.has(key) ? '' : DD_EMPTY_USER_TAG
    }

    carrier[key] = value
  }
}

function add (carrier, keyValuePairs, parseOtelTags = false, spaceSeparatedMode = false) {
  if (!carrier || !keyValuePairs) return
  try {
    if (Array.isArray(keyValuePairs)) {
      keyValuePairs.forEach(tags => add(carrier, tags, parseOtelTags))
    } else if (typeof keyValuePairs === 'string') {
      processStringTags(carrier, keyValuePairs, parseOtelTags, spaceSeparatedMode)
    } else {
      processObjectCarrier(carrier, keyValuePairs)
    }
  } catch (e) {
    log.error('Error adding tags', e)
  }
}

module.exports = { add }
