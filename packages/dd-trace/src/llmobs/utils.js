'use strict'

const { SPAN_KINDS, PARENT_ID_KEY, PROPAGATED_PARENT_ID_KEY, ML_APP, SESSION_ID } = require('./constants')
const { SPAN_TYPE } = require('../../../../ext/tags')

function validKind (kind) {
  return SPAN_KINDS.includes(kind)
}

function getName (kind, options = {}, fn) {
  return options.name || fn?.name || kind
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

  return span.context()._trace.tags[PROPAGATED_PARENT_ID_KEY]
}

function isLLMSpan (span) {
  return ['llm', 'openai'].includes(span?.context()._tags[SPAN_TYPE])
}

function getMlApp (span, defaultMlApp) {
  const mlApp = span.context()._tags[ML_APP]
  if (mlApp) return mlApp

  const nearest = nearestLLMObsAncestor(span)
  if (nearest) return nearest.context()._tags[ML_APP]

  return defaultMlApp || 'unknown-ml-app'
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

function getFunctionArguments (fn, args = []) {
  if (!fn) return

  try {
    const fnString = fn.toString()
    const matches = Array
      .from(
        fnString
          .slice(fnString.indexOf('(') + 1, fnString.lastIndexOf(')'))
          .matchAll(/(\.{3}\w+|\w+)\s*(?:=\s*([^,]+))?/g) || [] // this doesn't do well with nested objects
      )

    const names = matches.map(match => match[1]?.trim())

    const argsObject = {}

    for (const argIdx in args) {
      const name = names[argIdx]
      const arg = args[argIdx]

      const spread = name.startsWith('...')

      // this can only be the last argument
      if (spread) {
        argsObject[name.slice(3)] = args.slice(argIdx)
        break
      }

      argsObject[name] = arg
    }

    const numArgs = Object.keys(argsObject).length

    if (!numArgs) return undefined
    if (numArgs === 1) return Object.values(argsObject)[0]
    return argsObject
  } catch {
    return args
  }
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
