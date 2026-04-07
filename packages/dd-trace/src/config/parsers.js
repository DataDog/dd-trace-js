'use strict'

const fs = require('fs')

const tagger = require('../tagger')

let warnInvalidValue
function setWarnInvalidValue (fn) {
  warnInvalidValue = fn
}

const VALID_PROPAGATION_STYLES = new Set([
  'datadog', 'tracecontext', 'b3', 'b3 single header', 'b3multi', 'baggage', 'none',
])

function toCase (value, methodName) {
  if (Array.isArray(value)) {
    return value.map(item => {
      return transformers[methodName](item)
    })
  }
  return value[methodName]()
}

const transformers = {
  setGRPCRange (value) {
    if (value == null) {
      return
    }
    value = value.split(',')
    const result = []

    for (const val of value) {
      const dashIndex = val.indexOf('-')
      if (dashIndex === -1) {
        result.push(Number(val))
      } else {
        const start = Number(val.slice(0, dashIndex))
        const end = Number(val.slice(dashIndex + 1))
        for (let i = start; i <= end; i++) {
          result.push(i)
        }
      }
    }
    return result
  },
  toLowerCase (value) {
    return toCase(value, 'toLowerCase')
  },
  toUpperCase (value) {
    return toCase(value, 'toUpperCase')
  },
  toCamelCase (value) {
    if (Array.isArray(value)) {
      return value.map(item => {
        return transformers.toCamelCase(item)
      })
    }
    if (typeof value === 'object' && value !== null) {
      const result = {}
      for (const [key, innerValue] of Object.entries(value)) {
        const camelCaseKey = key.replaceAll(/_(\w)/g, (_, letter) => letter.toUpperCase())
        result[camelCaseKey] = transformers.toCamelCase(innerValue)
      }
      return result
    }
    return value
  },
  parseOtelTags (value, optionName) {
    return parsers.MAP(value
      ?.replace(/(^|,)deployment\.environment=/, '$1env:')
      .replace(/(^|,)service\.name=/, '$1service:')
      .replace(/(^|,)service\.version=/, '$1version:')
      .replaceAll('=', ':'), optionName)
  },
  normalizeProfilingEnabled (configValue) {
    if (configValue == null) {
      return
    }
    if (configValue === 'true' || configValue === '1') {
      return 'true'
    }
    if (configValue === 'false' || configValue === '0') {
      return 'false'
    }
    const lowercased = String(configValue).toLowerCase()
    if (lowercased !== configValue) {
      return transformers.normalizeProfilingEnabled(lowercased)
    }
    return configValue
  },
  sampleRate (value, optionName, source) {
    const number = Number(value)
    if (Number.isNaN(number) || value === null) {
      warnInvalidValue(value, optionName, source, 'Sample rate invalid')
      return
    }
    const clamped = Math.min(Math.max(number, 0), 1)
    if (clamped !== number) {
      warnInvalidValue(value, optionName, source, 'Sample rate out of range between 0 and 1')
      return clamped
    }
    return number
  },
  readFilePath (raw, optionName, source) {
    const { stackTraceLimit } = Error
    Error.stackTraceLimit = 0
    try {
      return fs.readFileSync(raw, 'utf8')
    } catch (error) {
      warnInvalidValue(raw, optionName, source, 'Error reading path', error)
    } finally {
      Error.stackTraceLimit = stackTraceLimit
    }
  },
  /**
   * Given a string of comma-separated paths, return the array of paths.
   * If a blank path is provided a null is returned to signal that the feature is disabled.
   * An empty array means the feature is enabled but that no rules need to be applied.
   *
   * @param {string | string[]} input
   */
  splitJSONPathRules (input) {
    if (!input || input === '$') return
    if (Array.isArray(input)) return input
    if (input === 'all') return []
    return input.split(',')
  },
  stripColonWhitespace (value) {
    if (Array.isArray(value)) {
      return value.map(item => {
        return transformers.stripColonWhitespace(item)
      })
    }
    return value.replaceAll(/\s*:\s*/g, ':')
  },
  validatePropagationStyles (value, optionName) {
    value = transformers.toLowerCase(value)
    for (const propagator of value) {
      if (!VALID_PROPAGATION_STYLES.has(propagator)) {
        warnInvalidValue(propagator, optionName, optionName, 'Invalid propagator')
        return
      }
    }
    return value
  },
}

const telemetryTransformers = {
  JSON (object) {
    return (typeof object !== 'object' || object === null) ? object : JSON.stringify(object)
  },
  MAP (object) {
    if (typeof object !== 'object' || object === null) {
      return object
    }
    let result = ''
    for (const [key, value] of Object.entries(object)) {
      result += `${key}:${value},`
    }
    return result.slice(0, -1)
  },
  ARRAY (array) {
    return Array.isArray(array) ? array.join(',') : array
  },
}

const parsers = {
  BOOLEAN (raw) {
    if (raw === 'true' || raw === '1') {
      return true
    }
    if (raw === 'false' || raw === '0') {
      return false
    }
    const lowercased = raw.toLowerCase()
    if (lowercased !== raw) {
      return parsers.BOOLEAN(lowercased)
    }
  },
  INT (raw) {
    const parsed = Math.trunc(raw)
    if (Number.isNaN(parsed)) {
      return
    }
    return parsed
  },
  DECIMAL (raw) {
    const parsed = Number(raw)
    if (Number.isNaN(parsed)) {
      return
    }
    return parsed
  },
  ARRAY (raw) {
    // TODO: Make the parsing a helper that is reused everywhere.
    const result = []
    if (!raw) {
      return result
    }
    let valueStart = 0
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i]
      if (char === ',') {
        const value = raw.slice(valueStart, i).trim()
        // Auto filter empty entries.
        if (value.length > 0) {
          result.push(value)
        }
        valueStart = i + 1
      }
    }
    if (valueStart < raw.length) {
      const value = raw.slice(valueStart).trim()
      // Auto filter empty entries.
      if (value.length > 0) {
        result.push(value)
      }
    }
    return result
  },
  MAP (raw, optionName) {
    /** @type {Record<string, string>} */
    const entries = {}
    if (!raw) {
      return entries
    }
    // DD_TAGS is a special case. It may be a map of key-value pairs separated by spaces.
    if (optionName === 'DD_TAGS' && !raw.includes(',')) {
      raw = raw.replaceAll(/\s+/g, ',')
    }
    tagger.add(entries, raw)
    return entries
  },
  JSON (raw) {
    const { stackTraceLimit } = Error
    Error.stackTraceLimit = 0
    try {
      return JSON.parse(raw)
    } catch {
      // ignore
    } finally {
      Error.stackTraceLimit = stackTraceLimit
    }
  },
  STRING (raw) {
    return raw
  },
}

module.exports = {
  parsers,
  transformers,
  telemetryTransformers,
  setWarnInvalidValue,
}
