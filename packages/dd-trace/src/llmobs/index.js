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

const LLMObsAgentlessSpanWriter = require('./writers/spans/agentless')
const LLMObsAgentProxySpanWriter = require('./writers/spans/agentProxy')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')

/**
 * Setting writers and processor globally when LLMObs is enabled
 * We're setting these in this module instead of on the SDK.
 * This is to isolate any subscribers and periodic tasks to this module,
 * and not conditionally instantiate in the SDK, since the SDK is always instantiated
 * if the tracer is `init`ed. But, in those cases, we don't want to start writers or subscribe
 * to channels.
 */

/** @type {LLMObsSpanProcessor} */
let spanProcessor

/** @type {LLMObsAgentProxySpanWriter|LLMObsAgentlessSpanWriter} */
let spanWriter

/** @type {LLMObsEvalMetricsWriter} */
let evalWriter

/**
 * Enables the relevant LLM Observability event listeners, and
 * additionally initializes the evaluation metrics writer, span writer, and span processor.
 * @param {import('../config')} config
 */
function enable (config) {
  // create writers and eval writer append and flush channels
  // span writer append is handled by the span processor
  evalWriter = new LLMObsEvalMetricsWriter(config)
  spanWriter = createSpanWriter(config)

  evalMetricAppendCh.subscribe(handleEvalMetricAppend)
  flushCh.subscribe(handleFlush)

  // span processing
  spanProcessor = new LLMObsSpanProcessor(config)
  spanProcessor.setWriter(spanWriter)
  spanProcessCh.subscribe(handleSpanProcess)

  // distributed tracing for llmobs
  injectCh.subscribe(handleLLMObsParentIdInjection)
}

/**
 * Disables the LLM Observability event listeners and destroys the writers and processor, and dereferences them.
 */
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

/**
 * Injects the parent LLM Observability span ID into the carrier
 * Since LLMObs traces can extend between services and be the same trace,
 * we need to propagate the parent id.
 * @param {{ carrier: Record<string, string> }} data
 *  - the data that includes the carrier to inject parent propogation information into
 * @returns {void}
 */
function handleLLMObsParentIdInjection ({ carrier }) {
  const parent = storage.getStore()?.span
  if (!parent) return

  const parentId = parent?.context().toSpanId()

  carrier['x-datadog-tags'] += `,${PROPAGATED_PARENT_ID_KEY}=${parentId}`
}

function createSpanWriter (config) {
  const SpanWriter = config.llmobs.agentlessEnabled ? LLMObsAgentlessSpanWriter : LLMObsAgentProxySpanWriter
  return new SpanWriter(config)
}

/**
 * Flushes both the span and evaluation metrics writers
 */
function handleFlush () {
  try {
    spanWriter.flush()
    evalWriter.flush()
  } catch (e) {
    log.warn(`Failed to flush LLMObs spans and evaluation metrics: ${e.message}`)
  }
}

/**
 * Passes the span data to the span processor
 * @param {{ span: import('../opentracing/span')}} data
 */
function handleSpanProcess (data) {
  spanProcessor.process(data)
}

/**
 * Enqueues the evaluation metric to be sent to LLM Observability
 * @param {*} payload
 */
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
