'use strict'

const { SPAN_KINDS, PARENT_ID_KEY, PROPAGATED_PARENT_ID_KEY, ML_APP, SESSION_ID } = require('./constants')
const { SPAN_TYPE } = require('../../../../ext/tags')

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
  // TODO(sam.brenner) add openai to this check
  return span?.context()._tags[SPAN_TYPE] === 'llm'
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

module.exports = {
  validKind,
  getName,
  getLLMObsParentId,
  isLLMSpan,
  getMlApp,
  getSessionId,
  encodeUnicode
}
