'use strict'

const log = require('../log')
const { PROPAGATED_PARENT_ID_KEY } = require('./constants/tags')
const { storage } = require('./storage')

const LLMObsSpanProcessor = require('./span_processor')

const { channel } = require('dc-polyfill')
const spanProcessCh = channel('dd-trace:span:process')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')

const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsSpanWriter = require('./writers/spans')

/**
 * Setting writers and processor globally when LLMObs is enabled
 * We're setting these in this module instead of on the SDK.
 * This is to isolate any subscribers and periodic tasks to this module,
 * and not conditionally instantiate in the SDK, since the SDK is always instantiated
 * if the tracer is `init`ed. But, in those cases, we don't want to start writers or subscribe
 * to channels.
 */
let spanProcessor
let spanWriter
let evalWriter

function enable (config) {
  // create writers and eval writer append and flush channels
  // span writer append is handled by the span processor
  const agentlessEnabled = getAgentlessEnabled(config)
  evalWriter = new LLMObsEvalMetricsWriter(config, agentlessEnabled)
  spanWriter = new LLMObsSpanWriter(config, agentlessEnabled)

  evalMetricAppendCh.subscribe(handleEvalMetricAppend)
  flushCh.subscribe(handleFlush)

  // span processing
  spanProcessor = new LLMObsSpanProcessor(config)
  spanProcessor.setWriter(spanWriter)
  spanProcessCh.subscribe(handleSpanProcess)

  // distributed tracing for llmobs
  injectCh.subscribe(handleLLMObsParentIdInjection)
}

function disable () {
  if (evalMetricAppendCh.hasSubscribers) evalMetricAppendCh.unsubscribe(handleEvalMetricAppend)
  if (flushCh.hasSubscribers) flushCh.unsubscribe(handleFlush)
  if (spanProcessCh.hasSubscribers) spanProcessCh.unsubscribe(handleSpanProcess)
  if (injectCh.hasSubscribers) injectCh.unsubscribe(handleLLMObsParentIdInjection)

  spanWriter?.destroy()
  evalWriter?.destroy()
  spanProcessor?.setWriter(null)

  spanWriter = null
  evalWriter = null
}

// since LLMObs traces can extend between services and be the same trace,
// we need to propogate the parent id.
function handleLLMObsParentIdInjection ({ carrier }) {
  const parent = storage.getStore()?.span
  if (!parent) return

  const parentId = parent?.context().toSpanId()

  carrier['x-datadog-tags'] += `,${PROPAGATED_PARENT_ID_KEY}=${parentId}`
}

function getAgentlessEnabled (config) {
  const { llmobs: { agentlessEnabled }, apiKey } = config

  // Explicitly disabled
  if (agentlessEnabled === false) {
    return false
  }

  // Explicitly enabled but missing API key
  if (agentlessEnabled === true && !apiKey) {
    throw new Error(
      'DD_API_KEY is required for sending LLMObs data when agentless mode is enabled. ' +
      'Ensure this configuration is set before running your application.'
    )
  }

  // Enable if API key present and not explicitly disabled
  return !!apiKey
}

function handleFlush () {
  try {
    spanWriter.flush()
    evalWriter.flush()
  } catch (e) {
    log.warn(`Failed to flush LLMObs spans and evaluation metrics: ${e.message}`)
  }
}

function handleSpanProcess (data) {
  spanProcessor.process(data)
}

function handleEvalMetricAppend (payload) {
  try {
    evalWriter.append(payload)
  } catch (e) {
    log.warn(`
      Failed to append evaluation metric to LLM Observability writer, likely due to an unserializable property.
      Evaluation metrics won't be sent to LLM Observability: ${e.message}
    `)
  }
}

module.exports = { enable, disable }
