'use strict'

const { SPAN_KINDS, PARENT_ID_KEY, PROPAGATED_PARENT_ID_KEY, ML_APP, SESSION_ID } = require('./constants')
const { SPAN_TYPE } = require('../../../../ext/tags')
const { isTrue, isFalse } = require('../util')

function validKind (kind) {
  // cases for invalid kind
  // 1. kind is not a string
  // 2. kind is not in SPAN_KINDS
  if (!SPAN_KINDS.includes(kind)) {
    return false
  }

  return true
}

function getName (kind, options = {}, fn = () => {}) {
  return options.name || fn.name || kind
}

function nearestLLMObsAncestor (span) {
  let parent = span._store?.span
  while (parent) {
    if (isLLMSpan(parent)) {
      return parent
    }
    parent = parent._store?.span
  }
  return undefined
}

function getLLMObsParentId (span) {
  if (!span) return undefined

  const parentIdTag = span.context()._tags[PARENT_ID_KEY]
  if (parentIdTag) return parentIdTag

  const nearest = nearestLLMObsAncestor(span)
  if (nearest) return nearest.context().toSpanId()

  return span.context()._tags[PROPAGATED_PARENT_ID_KEY]
}

function isLLMSpan (span) {
  return ['llm', 'openai'].includes(span?.context()._tags[SPAN_TYPE])
}

function getMlApp (span, defaultMlApp) {
  const mlApp = span.context()._tags[ML_APP]
  if (mlApp) return mlApp

  const nearest = nearestLLMObsAncestor(span)
  if (nearest) return nearest.context()._tags[ML_APP]

  return mlApp || defaultMlApp || 'unknown-ml-app'
}

function getSessionId (span) {
  let sessionId = span.context()._tags[SESSION_ID]
  if (sessionId) return sessionId

  const nearest = nearestLLMObsAncestor(span)
  if (nearest) sessionId = nearest.context()._tags[SESSION_ID]

  return sessionId || span.context().toTraceId(true)
}

// This takes about 1.3 ms for every 30k characters
function encodeUnicode (str) {
  if (!str) return str
  return str.split('').map(char => {
    const code = char.charCodeAt(0)
    if (code > 127) {
      return `\\u${code.toString(16).padStart(4, '0')}`
    }
    return char
  }).join('')
}

function getFunctionArguments (fn, args) {
  const fnString = fn.toString()
  const matches = Array
    .from(
      fnString
        .slice(fnString.indexOf('(') + 1, fnString.indexOf(')'))
        .matchAll(/(?:\s*(\w+)\s*(?:=\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\S+))?)\s*(?=,|$)/g) || []
    )
    .map(match => {
      const name = match[1].trim()
      const value = match[2]?.trim()
      return [name, value]
    })

  const defaultValues = {}
  const argNames = matches.map(([name, value]) => {
    defaultValues[name] = parseStringValue(value)
    return name
  })

  const argsObject = argNames.reduce((obj, name, idx) => {
    obj[name] = merge(args[idx], defaultValues[name])
    return obj
  }, {})

  if (Object.entries(argsObject).length === 1) return Object.values(argsObject)[0]
  return argsObject
}

function parseStringValue (str) {
  if (!str) return str

  const bool = isTrue(str) ? true : isFalse(str) ? false : undefined
  if (bool) return bool

  const number = parseFloat(str)
  if (!isNaN(number)) return number

  const validJsonStr = str.replace(/([a-zA-Z0-9_]+)\s*:/g, '"$1":')
  try {
    return JSON.parse(validJsonStr)
  } catch {
    if (
      (str.startsWith("'") && str.endsWith("'")) ||
      (str.startsWith('`') && str.endsWith('`'))
    ) {
      return str.slice(1, -1)
    }

    if (str === 'undefined') return undefined
    return str
  }
}
function merge (value, defaultValue) {
  if (!value) return defaultValue
  if (typeof value !== typeof defaultValue) return value

  const maybeEntries = Object.entries(value)
  if (!maybeEntries.length) return value

  const merged = {}
  maybeEntries.forEach(([k, v]) => {
    merged[k] = merge(v, defaultValue[k])
  })

  return { ...defaultValue, ...merged }
}

module.exports = {
  validKind,
  getName,
  getLLMObsParentId,
  isLLMSpan,
  getMlApp,
  getSessionId,
  encodeUnicode,
  getFunctionArguments
}
