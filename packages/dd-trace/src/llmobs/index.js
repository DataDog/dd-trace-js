'use strict'

const { handleSpanStart, handleSpanEnd, handleSpanError, registerPlugins } = require('./integrations')
const {
  llmobsSpanStartCh,
  llmobsSpanEndCh,
  llmobsSpanErrorCh
} = require('./integrations/channels')

// TODO(sam.brenner) integration enablement can happen here too

function enable (config) {
  registerPlugins(config)
  llmobsSpanStartCh.subscribe(handleSpanStart)
  llmobsSpanEndCh.subscribe(handleSpanEnd)
  llmobsSpanErrorCh.subscribe(handleSpanError)
}

function disable () {
  if (llmobsSpanStartCh.hasSubscribers) llmobsSpanStartCh.ubsubscribe(handleSpanStart)
  if (llmobsSpanEndCh.hasSubscribers) llmobsSpanEndCh.unsubscribe(handleSpanEnd)
  if (llmobsSpanErrorCh.hasSubscribers) llmobsSpanErrorCh.unsubscribe(handleSpanError)
}

module.exports = { enable, disable }
