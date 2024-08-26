'use strict'

const { handleSpanStart, handleSpanEnd, handleSpanError, registerPlugins } = require('./integrations')
const {
  llmobsSpanStartCh,
  llmobsSpanEndCh,
  llmobsSpanErrorCh,
  injectCh
} = require('./integrations/channels')

const tracer = require('../../../../')
const log = require('../log')
const { isLLMSpan, getLLMObsParentId } = require('./util')
const { PROPAGATED_PARENT_ID_KEY } = require('./constants')

// TODO(sam.brenner) integration enablement can happen here too

function enable (config) {
  registerPlugins(config)
  llmobsSpanStartCh.subscribe(handleSpanStart)
  llmobsSpanEndCh.subscribe(handleSpanEnd)
  llmobsSpanErrorCh.subscribe(handleSpanError)

  injectCh.subscribe(handleLLMObsParentIdInjection)
}

function disable () {
  if (llmobsSpanStartCh.hasSubscribers) llmobsSpanStartCh.ubsubscribe(handleSpanStart)
  if (llmobsSpanEndCh.hasSubscribers) llmobsSpanEndCh.unsubscribe(handleSpanEnd)
  if (llmobsSpanErrorCh.hasSubscribers) llmobsSpanErrorCh.unsubscribe(handleSpanError)

  if (injectCh.hasSubscribers) injectCh.unsubscribe(handleLLMObsParentIdInjection)
}

// TODO(sam.brenner) remove this once LLMObs submits APM skeleton spans
function handleLLMObsParentIdInjection ({ spanContext, carrier }) {
  const span = tracer.scope().active() // this is one above the outbound span
  if (!span) {
    log.warn('No active span to inject LLMObs parent ID info.')
    return
  }

  let parentId
  if (isLLMSpan(span)) {
    parentId = span.context().toSpanId()
  } else {
    parentId = getLLMObsParentId(span)
  }

  carrier['x-datadog-tags'] += `,${PROPAGATED_PARENT_ID_KEY}=${parentId}`
}

module.exports = { enable, disable }
