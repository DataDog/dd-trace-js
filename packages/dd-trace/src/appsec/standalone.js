'use strict'

const { channel } = require('dc-polyfill')
const startCh = channel('dd-trace:span:start')
const { APM_TRACING_ENABLED_KEY, APPSEC_PROPAGATION_KEY } = require('../constants')

let enabled

function isStandaloneEnabled () {
  return enabled
}

function onSpanStart ({ span, fields }) {
  const tags = span.context()?._tags
  if (!tags) return

  const { parent } = fields
  if (!parent || parent._isRemote) {
    tags[APM_TRACING_ENABLED_KEY] = 0
  }
}

function configure (config) {
  const configChanged = enabled !== config.appsec?.standalone?.enabled
  if (!configChanged) return

  enabled = config.appsec?.standalone?.enabled

  if (enabled) {
    startCh.subscribe(onSpanStart)
  } else {
    startCh.unsubscribe(onSpanStart)
  }
}

function sample (span) {
  if (enabled) {
    span.context()._trace.tags[APPSEC_PROPAGATION_KEY] = '1'
  }
}

module.exports = {
  isStandaloneEnabled,
  configure,
  sample
}
