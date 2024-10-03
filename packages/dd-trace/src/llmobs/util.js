'use strict'

const { SPAN_TYPE } = require('../../../../ext/tags')

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

function isLLMObsSpan (span) {
  return ['llm', 'openai'].includes(span?.context()._tags[SPAN_TYPE])
}

module.exports = {
  encodeUnicode,
  isLLMObsSpan
}
