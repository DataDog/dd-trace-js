'use strict'

const { storage } = require('../../../../datadog-core')

function getRootSpan () {
  let span = storage('legacy').getStore()?.span
  if (!span) return

  const context = span.context()
  const started = context._trace.started

  let parentId = context._parentId
  while (parentId) {
    const parent = started.find(s => s.context()._spanId === parentId)
    const pContext = parent?.context()

    if (!pContext) break

    parentId = pContext._parentId

    if (!pContext._tags?._inferred_span) {
      span = parent
    }
  }

  return span
}

module.exports = {
  getRootSpan,
}
