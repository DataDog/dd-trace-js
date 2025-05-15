'use strict'

const log = require('../log')
const {
  ML_APP,
  PROPAGATED_ML_APP_KEY,
  PROPAGATED_PARENT_ID_KEY
} = require('./constants/tags')
const { storage } = require('./storage')

const LLMObsSpanProcessor = require('./span_processor')

const telemetry = require('./telemetry')
const { channel } = require('dc-polyfill')
const spanProcessCh = channel('dd-trace:span:process')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')

const LLMObsAgentlessSpanWriter = require('./writers/spans/agentless')
const LLMObsAgentProxySpanWriter = require('./writers/spans/agentProxy')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsTagger = require('./tagger')

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

/** @type {import('../config')} */
let globalTracerConfig

function enable (config) {
  globalTracerConfig = config

  const startTime = performance.now()
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
  telemetry.recordLLMObsEnabled(startTime, config)
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
// we need to propagate the parent id and mlApp.
function handleLLMObsParentIdInjection ({ carrier }) {
  const parent = storage.getStore()?.span
  const mlObsSpanTags = LLMObsTagger.tagMap.get(parent)

  const parentId = parent?.context().toSpanId()
  const mlApp = mlObsSpanTags?.[ML_APP] || globalTracerConfig.llmobs.mlApp

  if (parentId) carrier['x-datadog-tags'] += `,${PROPAGATED_PARENT_ID_KEY}=${parentId}`
  if (mlApp) carrier['x-datadog-tags'] += `,${PROPAGATED_ML_APP_KEY}=${mlApp}`
}

function createSpanWriter (config) {
  const SpanWriter = config.llmobs.agentlessEnabled ? LLMObsAgentlessSpanWriter : LLMObsAgentProxySpanWriter
  return new SpanWriter(config)
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
