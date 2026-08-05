'use strict'

const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'

function getFirstTextContent (content) {
  if (!Array.isArray(content)) return

  for (const item of content) {
    if (item.type === 'text' && item.text) return item.text
  }
}

function setErrorTags (span, message) {
  span.setTag('error', 1)
  span.setTag(ERROR_TYPE, 'Error')
  span.setTag(ERROR_MESSAGE, message)
}

function tagErrorResult (span, result) {
  if (result?.isError) {
    setErrorTags(span, getFirstTextContent(result.content) || 'Tool call returned isError: true')
  }
}

module.exports = {
  DISTRIBUTED_TRACE_META_KEY,
  tagErrorResult,
}
