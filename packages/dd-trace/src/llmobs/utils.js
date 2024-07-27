'use strict'

const { SPAN_KINDS, PARENT_ID_KEY, PROPAGATED_PARENT_ID_KEY, ML_APP, SESSION_ID } = require('./constants')
const { SPAN_TYPE } = require('../../../../ext/tags')

function validateKind (kind) {
  // cases for invalid kind
  // 1. kind is not a string
  // 2. kind is not in SPAN_KINDS
  if (!SPAN_KINDS.includes(kind)) {
    // log error
  }
}

function getName (kind, options = {}, fn) {
  let primary
  if (fn) {
    primary = fn.name || options.name
  } else {
    primary = options.name
  }

  return primary || kind
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
  if (nearest) return nearest.context()._spanId

  return span.context()._tags[PROPAGATED_PARENT_ID_KEY]
}

function isLLMSpan (span) {
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

  return sessionId || span.context()._traceId.toString()
}

module.exports = {
  validateKind,
  getName,
  getLLMObsParentId,
  isLLMSpan,
  getMlApp,
  getSessionId
}
