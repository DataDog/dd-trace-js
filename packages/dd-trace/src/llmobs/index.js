'use strict'

const log = require('../log')
const {
  ML_APP,
  PROPAGATED_ML_APP_KEY,
  PROPAGATED_PARENT_ID_KEY
} = require('./constants/tags')
const { storage } = require('./storage')

const telemetry = require('./telemetry')
const LLMObsSpanProcessor = require('./span_processor')

const { channel } = require('dc-polyfill')
const spanProcessCh = channel('dd-trace:span:process')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')

const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsTagger = require('./tagger')
const LLMObsSpanWriter = require('./writers/spans')
const { setAgentStrategy } = require('./writers/util')

const util = require('node:util')

/**
 * Setting writers and processor globally when LLMObs is enabled
 * We're setting these in this module instead of on the SDK.
 * This is to isolate any subscribers and periodic tasks to this module,
 * and not conditionally instantiate in the SDK, since the SDK is always instantiated
 * if the tracer is `init`ed. But, in those cases, we don't want to start writers or subscribe
 * to channels.
 */

/** @type {LLMObsSpanProcessor | null} */
let spanProcessor

/** @type {LLMObsSpanWriter | null} */
let spanWriter

/** @type {LLMObsEvalMetricsWriter | null} */
let evalWriter

/** @type {import('../config')} */
let globalTracerConfig

function enable (config) {
  globalTracerConfig = config

  const startTime = performance.now()
  // create writers and eval writer append and flush channels
  // span writer append is handled by the span processor
  evalWriter = new LLMObsEvalMetricsWriter(config)
  spanWriter = new LLMObsSpanWriter(config)

  evalMetricAppendCh.subscribe(handleEvalMetricAppend)
  flushCh.subscribe(handleFlush)

  // span processing
  spanProcessor = new LLMObsSpanProcessor(config)
  spanProcessor.setWriter(spanWriter)
  spanProcessCh.subscribe(handleSpanProcess)

  // distributed tracing for llmobs
  injectCh.subscribe(handleLLMObsParentIdInjection)

  setAgentStrategy(config, useAgentless => {
    if (useAgentless && !(config.apiKey && config.site)) {
      throw new Error(
        'Cannot send LLM Observability data without a running agent or without both a Datadog API key and site.\n' +
        'Ensure these configurations are set before running your application.'
      )
    }

    evalWriter?.setAgentless(useAgentless)
    spanWriter?.setAgentless(useAgentless)

    telemetry.recordLLMObsEnabled(startTime, config)
    log.debug(`[LLMObs] Enabled LLM Observability with configuration: ${util.inspect(config.llmobs)}`)
  })
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

  log.debug('[LLMObs] Disabled LLM Observability')
}

// since LLMObs traces can extend between services and be the same trace,
// we need to propagate the parent id and mlApp.
function handleLLMObsParentIdInjection ({ carrier }) {
  const parent = storage.getStore()?.span
  const mlObsSpanTags = LLMObsTagger.tagMap.get(parent)

  const parentContext = parent?.context()
  const parentId = parentContext?.toSpanId()
  const mlApp =
    mlObsSpanTags?.[ML_APP] ||
    parentContext?._trace?.tags?.[PROPAGATED_ML_APP_KEY] ||
    globalTracerConfig.llmobs.mlApp

  if (parentId) carrier['x-datadog-tags'] += `,${PROPAGATED_PARENT_ID_KEY}=${parentId}`
  if (mlApp) carrier['x-datadog-tags'] += `,${PROPAGATED_ML_APP_KEY}=${mlApp}`
}

function handleFlush () {
  let err = ''
  try {
    spanWriter.flush()
    evalWriter.flush()
  } catch (e) {
    err = 'writer_flush_error'
    log.warn('Failed to flush LLMObs spans and evaluation metrics:', e.message)
  }
  telemetry.recordUserFlush(err)
}

function handleSpanProcess (data) {
  spanProcessor.process(data)
}

function handleEvalMetricAppend (payload) {
  try {
    evalWriter.append(payload)
  } catch (e) {
    log.warn(
      // eslint-disable-next-line @stylistic/max-len
      'Failed to append evaluation metric to LLM Observability writer, likely due to an unserializable property. Evaluation metrics won\'t be sent to LLM Observability:',
      e.message
    )
  }
}

module.exports = { enable, disable }
