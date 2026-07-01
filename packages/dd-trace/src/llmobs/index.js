'use strict'

const { channel } = require('dc-polyfill')

const log = require('../log')
const { DD_MAJOR } = require('../../../../version')
const startupLogs = require('../startup-log')
const {
  ML_APP,
  PROPAGATED_ML_APP_KEY,
  PROPAGATED_PARENT_ID_KEY,
  PROPAGATED_PARENT_AGENT_ID_KEY,
  PROPAGATED_PARENT_AGENT_NAME_KEY,
  SAMPLE_RATE,
  SAMPLING_DECISION,
  PROPAGATED_SAMPLE_RATE_KEY,
  PROPAGATED_SAMPLING_DECISION_KEY,
} = require('./constants/tags')
const { storage } = require('./storage')
const { agentNameWireSafe } = require('./util')
const telemetry = require('./telemetry')
const LLMObsSpanProcessor = require('./span_processor')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsTagger = require('./tagger')
const LLMObsSpanWriter = require('./writers/spans')
const { setAgentStrategy } = require('./writers/util')
const { INCOMPATIBLE_INITIALIZATION } = require('./constants/text')

const spanFinishCh = channel('dd-trace:span:finish')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')
const registerUserSpanProcessorCh = channel('llmobs:register-processor')

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

/** @type {import('../config/config-base')} */
let globalTracerConfig

/**
 * @param {@type import('../config/config-base')} config
 */
function enable (config) {
  globalTracerConfig = config

  const startTime = performance.now()
  // create writers and eval writer append and flush channels
  // span writer append is handled by the span processor
  evalWriter = new LLMObsEvalMetricsWriter(config)
  spanWriter = new LLMObsSpanWriter(config)

  evalMetricAppendCh.subscribe(handleEvalMetricAppend)
  flushCh.subscribe(handleFlush)
  registerUserSpanProcessorCh.subscribe(handleRegisterProcessor)

  // span processing
  spanProcessor = new LLMObsSpanProcessor(config)
  spanProcessor.setWriter(spanWriter)
  spanFinishCh.subscribe(handleSpanProcess)

  // distributed tracing for llmobs
  injectCh.subscribe(handleLLMObsInjection)

  setAgentStrategy(config, useAgentless => {
    if (useAgentless && !(config.DD_API_KEY && config.site)) {
      if (DD_MAJOR < 6 || !config?.startupLogs) {
        // eslint-disable-next-line no-console
        console.error(INCOMPATIBLE_INITIALIZATION)
      } else {
        startupLogs.logGenericError(INCOMPATIBLE_INITIALIZATION)
      }
    }

    evalWriter?.setAgentless(useAgentless)
    spanWriter?.setAgentless(useAgentless)

    telemetry.recordLLMObsEnabled(startTime, config)
    log.debug('[LLMObs] Enabled LLM Observability with configuration: %o', config.llmobs)
  })
}

function disable () {
  if (evalMetricAppendCh.hasSubscribers) evalMetricAppendCh.unsubscribe(handleEvalMetricAppend)
  if (flushCh.hasSubscribers) flushCh.unsubscribe(handleFlush)
  if (spanFinishCh.hasSubscribers) spanFinishCh.unsubscribe(handleSpanProcess)
  if (injectCh.hasSubscribers) injectCh.unsubscribe(handleLLMObsInjection)
  if (registerUserSpanProcessorCh.hasSubscribers) registerUserSpanProcessorCh.unsubscribe(handleRegisterProcessor)

  spanWriter?.destroy()
  evalWriter?.destroy()
  spanProcessor?.setWriter(null)

  spanWriter = null
  evalWriter = null

  log.debug('[LLMObs] Disabled LLM Observability')
}

// since LLMObs traces can extend between services and be the same trace,
// we need to propagate the parent id, mlApp, and sampling rate/decision.
function handleLLMObsInjection ({ carrier }) {
  // Respect the standard propagator's gate: when trace tag propagation is
  // disabled, don't write `x-datadog-tags` for LLMObs either.
  if (globalTracerConfig.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH === 0) return

  const parent = storage.getStore()?.span
  const mlObsSpanTags = LLMObsTagger.tagMap.get(parent)

  const parentContext = parent?.context()
  const parentId = parentContext?.toSpanId()
  const mlApp =
    mlObsSpanTags?.[ML_APP] ||
    parentContext?._trace?.tags?.[PROPAGATED_ML_APP_KEY] ||
    globalTracerConfig.llmobs.mlApp

  const sampleRate =
    mlObsSpanTags?.[SAMPLE_RATE] ?? parentContext?._trace?.tags?.[PROPAGATED_SAMPLE_RATE_KEY]
  const samplingDecision =
    mlObsSpanTags?.[SAMPLING_DECISION] ?? parentContext?._trace?.tags?.[PROPAGATED_SAMPLING_DECISION_KEY]

  if (!parentId && !mlApp && samplingDecision == null) return

  // Propagate the nearest agent so spans in the downstream process attribute correctly. When the
  // active span sits under a distributed agent, `resolveAgentAttribution` inherits the propagated
  // id/name already on the parent's registry entry, so the chain survives multiple hops. Resolved
  // after the bail-out above so we don't allocate when there is nothing to inject.
  const { name: parentAgentName, spanId: parentAgentSpanId } = LLMObsTagger.resolveAgentAttribution(parent)

  // `_injectTags` only writes `x-datadog-tags` when the trace has `_dd.p.*`
  // tags, so it may be undefined here — coalesce before appending.
  const existing = carrier['x-datadog-tags']
  let tags = existing || ''
  if (parentId) tags += `${tags ? ',' : ''}${PROPAGATED_PARENT_ID_KEY}=${parentId}`
  if (mlApp) tags += `${tags ? ',' : ''}${PROPAGATED_ML_APP_KEY}=${mlApp}`
  if (sampleRate != null) tags += `${tags ? ',' : ''}${PROPAGATED_SAMPLE_RATE_KEY}=${sampleRate}`
  if (samplingDecision != null) tags += `${tags ? ',' : ''}${PROPAGATED_SAMPLING_DECISION_KEY}=${samplingDecision}`
  // The id is always digit-safe; skip an unsafe name (id-only) rather than letting the tagset
  // encoder drop the whole header. The backend resolves the name from the id in that case.
  if (parentAgentSpanId) tags += `${tags ? ',' : ''}${PROPAGATED_PARENT_AGENT_ID_KEY}=${parentAgentSpanId}`
  if (parentAgentName && agentNameWireSafe(parentAgentName)) {
    const nameEntry = `${tags ? ',' : ''}${PROPAGATED_PARENT_AGENT_NAME_KEY}=${parentAgentName}`
    if (tags.length + nameEntry.length <= globalTracerConfig.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH) {
      tags += nameEntry
    }
  }
  if (tags !== existing) carrier['x-datadog-tags'] = tags
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

function handleRegisterProcessor (userSpanProcessor) {
  spanProcessor.setUserSpanProcessor(userSpanProcessor)
}

function handleSpanProcess (span) {
  spanProcessor.process(span)
}

function handleEvalMetricAppend ({ payload, routing }) {
  try {
    evalWriter.append(payload, routing)
  } catch (e) {
    log.warn(
      // eslint-disable-next-line @stylistic/max-len
      'Failed to append evaluation metric to LLM Observability writer, likely due to an unserializable property. Evaluation metrics won\'t be sent to LLM Observability:',
      e.message
    )
  }
}

module.exports = { enable, disable }
