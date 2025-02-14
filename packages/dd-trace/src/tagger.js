'use strict'

const constants = require('./constants')
const log = require('./log')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, DD_EMPTY_USER_TAG } = constants

const otelTagMap = {
  'deployment.environment': 'env',
  'service.name': 'service',
  'service.version': 'version'
}

const skipEmptyString = new Set(['env', 'service', 'version'])

function add (carrier, keyValuePairs, parseOtelTags = false, emptyUserTags = true) {
  if (!carrier || !keyValuePairs) return

  if (Array.isArray(keyValuePairs)) {
    for (const item of keyValuePairs) {
      add(carrier, item, parseOtelTags, emptyUserTags)
    }
    return
  }

  if (typeof keyValuePairs === 'object') {
    if ([ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE].some(key => key in keyValuePairs) &&
        !('doNotSetTraceError' in keyValuePairs)) {
      carrier.setTraceError = true
    }
    Object.assign(carrier, keyValuePairs)
    return
  }

  try {
    // Decide whether to split by comma or whitespace
    const isCommaMode = keyValuePairs.includes(',')
    const segments = (isCommaMode
      ? keyValuePairs.split(',')
      : keyValuePairs.split(/\s+/)
    )
      .map(s => s.trim()) // trim each segment
      .filter(Boolean) // drop empty segments

    const sep = parseOtelTags ? '=' : ':'

    for (const seg of segments) {
      const idx = seg.indexOf(sep)

      if (idx < 0) {
        if (isCommaMode) {
          // In comma mode, only store single-character segments
          if (seg.length === 1) {
            carrier[seg] = skipEmptyString.has(seg)
              ? '' // if key in skipEmptyString => store ''
              : emptyUserTags ? DD_EMPTY_USER_TAG : ''
          }
        } else {
          // Whitespace mode => any segment with no colon => empty tag
          carrier[seg] = skipEmptyString.has(seg)
            ? ''
            : emptyUserTags ? DD_EMPTY_USER_TAG : ''
        }
      } else {
        // We have a separator => parse out key/value
        let key = seg.slice(0, idx).trim()
        let val = seg.slice(idx + 1).trim()
        if (!key) continue

        // OTEL mapping if parseOtelTags is true
        if (parseOtelTags && otelTagMap[key]) {
          key = otelTagMap[key]
        }

        // If val is empty, decide if we store empty string or DD_EMPTY_USER_TAG
        if (!val) {
          val = skipEmptyString.has(key)
            ? ''
            : emptyUserTags ? DD_EMPTY_USER_TAG : ''
        }
        carrier[key] = val
      }
    }
  } catch (err) {
    log.error('Error adding tags', err)
  }
}

module.exports = { add }
