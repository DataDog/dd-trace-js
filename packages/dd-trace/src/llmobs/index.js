'use strict'

const { handleSpanStart, handleSpanEnd, handleSpanError, registerPlugins } = require('./integrations')
const {
  llmobsSpanStartCh,
  llmobsSpanEndCh,
  llmobsSpanErrorCh,
  injectCh
} = require('./integrations/channels')

const log = require('../log')
const { PROPAGATED_PARENT_ID_KEY, PROPAGATED_TRACE_ID_KEY, TRACE_ID } = require('./constants')
const { storage } = require('../../../datadog-core')

function enable (config) {
  registerPlugins(config)
  llmobsSpanStartCh.subscribe(handleSpanStart)
  llmobsSpanEndCh.subscribe(handleSpanEnd)
  llmobsSpanErrorCh.subscribe(handleSpanError)

  injectCh.subscribe(handleLLMObsParentIdInjection)
}

function disable () {
  if (llmobsSpanStartCh.hasSubscribers) llmobsSpanStartCh.unsubscribe(handleSpanStart)
  if (llmobsSpanEndCh.hasSubscribers) llmobsSpanEndCh.unsubscribe(handleSpanEnd)
  if (llmobsSpanErrorCh.hasSubscribers) llmobsSpanErrorCh.unsubscribe(handleSpanError)

  if (injectCh.hasSubscribers) injectCh.unsubscribe(handleLLMObsParentIdInjection)
}

function handleLLMObsParentIdInjection ({ carrier }) {
  const parent = storage.getStore().llmobsSpan
  if (!parent) {
    log.warn('No active span to inject LLMObs info.')
    return
  }

  const parentId = parent?.context().toSpanId()
  const traceId = parent?.context()._tags[TRACE_ID]

  carrier['x-datadog-tags'] += `,${PROPAGATED_PARENT_ID_KEY}=${parentId},${PROPAGATED_TRACE_ID_KEY}=${traceId}`
}

module.exports = { enable, disable }
