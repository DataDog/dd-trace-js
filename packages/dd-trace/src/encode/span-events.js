'use strict'

const { eventTimeNano } = require('./tags-processors')

/**
 * @param {Array<{ name: unknown, startTime: number, attributes?: object }>} spanEvents
 * @returns {string}
 */
function stringifySpanEvents (spanEvents) {
  let result = '['
  for (let index = 0; index < spanEvents.length; index++) {
    if (index > 0) result += ','
    const event = spanEvents[index]
    const attributes = event.attributes
    if (typeof event.name !== 'string') {
      result += JSON.stringify({ name: event.name, time_unix_nano: eventTimeNano(event), attributes })
      continue
    }
    result += '{"name":' + escapeJsonString(event.name) +
      ',"time_unix_nano":' + jsonNumber(eventTimeNano(event))
    if (attributes) {
      result += ',"attributes":' + stringifyAttributes(attributes)
    }
    result += '}'
  }
  return result + ']'
}

/**
 * @param {object} attributes
 * @returns {string}
 */
function stringifyAttributes (attributes) {
  let result = '{'
  let first = true
  for (const key of Object.keys(attributes)) {
    if (first) {
      first = false
    } else {
      result += ','
    }
    result += escapeJsonString(key) + ':' + stringifyAttributeValue(attributes[key])
  }
  return result + '}'
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyAttributeValue (value) {
  if (typeof value === 'string') return escapeJsonString(value)
  if (typeof value === 'number') return jsonNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    let result = '['
    for (let index = 0; index < value.length; index++) {
      if (index > 0) result += ','
      result += stringifyAttributeValue(value[index])
    }
    return result + ']'
  }
  return 'null'
}

/**
 * @param {number} value
 * @returns {string}
 */
function jsonNumber (value) {
  return Number.isFinite(value) ? String(value) : 'null'
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeJsonString (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x22 || code === 0x5C || (code >= 0xD8_00 && code <= 0xDF_FF)) {
      return JSON.stringify(value)
    }
  }
  return '"' + value + '"'
}

module.exports = { stringifySpanEvents }
