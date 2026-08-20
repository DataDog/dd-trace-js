'use strict'

const { storage } = require('../../../../datadog-core')
const { getAppSecRootSpan } = require('../../opentracing/span-projections')

function getRootSpan () {
  const span = storage('legacy').getStore()?.span
  if (!span) return
  return getAppSecRootSpan(span)
}

module.exports = {
  getRootSpan,
}
