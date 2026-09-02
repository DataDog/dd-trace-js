'use strict'

const { channel } = require('dc-polyfill')

const { registerTelemetryFlusher } = require('../flush')
const log = require('../log')
const { createServerlessDeliveryTracker } = require('../serverless')
const { DD_MAJOR } = require('../../../../version')
const startupLogs = require('../startup-log')
const {
  ML_APP,
  SESSION_ID,
  SESSION_ID_TRACE_DEFAULT_KEY,
  PROPAGATED_ML_APP_KEY,
  PROPAGATED_PARENT_ID_KEY,
  PROPAGATED_SESSION_ID_KEY,
  PROPAGATED_PARENT_AGENT_ID_KEY,
  PROPAGATED_PARENT_AGENT_NAME_KEY,
  SAMPLE_RATE,
  SAMPLING_DECISION,
  PROPAGATED_SAMPLE_RATE_KEY,
  PROPAGATED_SAMPLING_DECISION_KEY,
  TRACE_ID,
  PROPAGATED_TRACE_ID_KEY,
} = require('./constants/tags')
const { storage } = require('./storage')
const { agentNameWireSafe, resolveAgentAttribution } = require('./util')
const telemetry = require('./telemetry')
const LLMObsSpanProcessor = require('./span_processor')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsTagger = require('./tagger')
const LLMObsSpanWriter = require('./writers/spans')
const { setAgentStrategy } = require('./writers/util')
const { INCOMPATIBLE_INITIALIZATION } = require('./constants/text')
const { llmObsTraceIdToWire } = require('./util')

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

let unregisterTelemetryFlusher

/** @type {import('../config/config-base')} */
let globalTracerConfig

/**
 * @typedef {object} TraceTagInjection
 * @property {import('../opentracing/span_context')} spanContext
 * @property {Record<string, string | undefined>} [traceTagReplacements]
 * @property {number} [optionalTraceTagCount]
 */

/**
 * @param {@type import('../config/config-base')} config
 */
function enable (config) {
  globalTracerConfig = config

  const retiredSpanWriter = spanWriter
  const retiredEvalWriter = evalWriter
  const isReinitializing = Boolean(retiredSpanWriter || retiredEvalWriter)
  unregisterTelemetryFlusher?.()
  retireWriters(retiredSpanWriter, retiredEvalWriter)

  const startTime = performance.now()
  // create writers and eval writer append and flush channels
  // span writer append is handled by the span processor
  evalWriter = new LLMObsEvalMetricsWriter(config)
  spanWriter = new LLMObsSpanWriter(config)
  const currentEvalWriter = evalWriter
  const currentSpanWriter = spanWriter
  unregisterTelemetryFlusher = registerTelemetryFlusher(done => {
    flushWriters(done, currentSpanWriter, currentEvalWriter)
  })

  if (!isReinitializing) {
    evalMetricAppendCh.subscribe(handleEvalMetricAppend)
    flushCh.subscribe(handleFlush)
    registerUserSpanProcessorCh.subscribe(handleRegisterProcessor)
  }

  // span processing
  spanProcessor = new LLMObsSpanProcessor(config)
  spanProcessor.setWriter(spanWriter)
  if (!isReinitializing) spanFinishCh.subscribe(handleSpanProcess)

  // distributed tracing for llmobs
  if (!isReinitializing) injectCh.subscribe(handleLLMObsInjection)

  setAgentStrategy(config, useAgentless => {
    if (useAgentless && !(config.DD_API_KEY && config.site)) {
      if (DD_MAJOR < 6 || !config?.startupLogs) {
        // eslint-disable-next-line no-console
        console.error(INCOMPATIBLE_INITIALIZATION)
      } else {
        startupLogs.logGenericError(INCOMPATIBLE_INITIALIZATION)
      }
    }

    // A disable can happen while transport selection is still pending. Keep
    // configuring these writers so their queued lifecycle flushes can drain.
    currentEvalWriter.setAgentless(useAgentless)
    currentSpanWriter.setAgentless(useAgentless)

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

  const retiredSpanWriter = spanWriter
  const retiredEvalWriter = evalWriter
  spanProcessor?.setWriter(null)
  unregisterTelemetryFlusher?.()
  unregisterTelemetryFlusher = undefined

  spanWriter = null
  evalWriter = null

  retireWriters(retiredSpanWriter, retiredEvalWriter)

  log.debug('[LLMObs] Disabled LLM Observability')
}

/**
 * Keeps retired writers reachable until their destroy-triggered deliveries complete.
 * @param {LLMObsSpanWriter | null} retiredSpanWriter
 * @param {LLMObsEvalMetricsWriter | null} retiredEvalWriter
 * @returns {void}
 */
function retireWriters (retiredSpanWriter, retiredEvalWriter) {
  const retiredWriters = [retiredSpanWriter, retiredEvalWriter].filter(Boolean)
  if (retiredWriters.length === 0) return
  let remainingWriters = retiredWriters.length
  const unregisterRetiredFlusher = registerTelemetryFlusher(done => {
    flushWriters(done, retiredSpanWriter, retiredEvalWriter)
  })
  function onWriterDestroyed () {
    if (--remainingWriters === 0) unregisterRetiredFlusher?.()
  }
  for (const writer of retiredWriters) writer.destroy(onWriterDestroyed)
}

// since LLMObs traces can extend between services and be the same trace,
// we need to propagate the parent id, mlApp, session id, and sampling rate/decision.
/** @param {TraceTagInjection} injection */
function handleLLMObsInjection (injection) {
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
  const sessionId =
    mlObsSpanTags?.[SESSION_ID] ??
    parentContext?._trace?.tags?.[SESSION_ID_TRACE_DEFAULT_KEY] ??
    parentContext?._trace?.tags?.[PROPAGATED_SESSION_ID_KEY]
  const llmobsTraceId = mlObsSpanTags?.[TRACE_ID]
  const propagatedTraceId = llmobsTraceId === undefined
    ? parentContext?._trace?.tags?.[PROPAGATED_TRACE_ID_KEY]
    : llmObsTraceIdToWire(llmobsTraceId)

  if (!parentId && !mlApp && samplingDecision == null && !sessionId && !propagatedTraceId) return

  // Propagate the nearest agent so spans in the downstream process attribute correctly. When the
  // active span sits under a distributed agent, `resolveAgentAttribution` inherits the propagated
  // id/name already on the parent's registry entry, so the chain survives multiple hops. Resolved
  // after the bail-out above so we don't allocate when there is nothing to inject.
  const { name: parentAgentName, spanId: parentAgentSpanId } = resolveAgentAttribution(
    mlObsSpanTags, parent
  )

  const traceTagReplacements = {}
  if (parentId) traceTagReplacements[PROPAGATED_PARENT_ID_KEY] = parentId
  if (mlApp) traceTagReplacements[PROPAGATED_ML_APP_KEY] = mlApp
  if (sessionId) traceTagReplacements[PROPAGATED_SESSION_ID_KEY] = sessionId
  if (sampleRate != null) traceTagReplacements[PROPAGATED_SAMPLE_RATE_KEY] = sampleRate.toString()
  if (samplingDecision != null) {
    traceTagReplacements[PROPAGATED_SAMPLING_DECISION_KEY] = samplingDecision.toString()
  }
  if (propagatedTraceId != null) traceTagReplacements[PROPAGATED_TRACE_ID_KEY] = propagatedTraceId

  let optionalTraceTagCount = 0
  if (parentAgentSpanId) {
    traceTagReplacements[PROPAGATED_PARENT_AGENT_ID_KEY] = parentAgentSpanId
    optionalTraceTagCount++
    if (parentAgentName && agentNameWireSafe(parentAgentName)) {
      traceTagReplacements[PROPAGATED_PARENT_AGENT_NAME_KEY] = parentAgentName
    } else {
      traceTagReplacements[PROPAGATED_PARENT_AGENT_NAME_KEY] = undefined
    }
    optionalTraceTagCount++
  }

  injection.traceTagReplacements = traceTagReplacements
  injection.optionalTraceTagCount = optionalTraceTagCount
}

/**
 * Flushes the specified LLMObs writers and joins deliveries active at the boundary.
 * @param {Function} [done]
 * @param {LLMObsSpanWriter | null} [currentSpanWriter]
 * @param {LLMObsEvalMetricsWriter | null} [currentEvalWriter]
 * @returns {boolean} `true` when a writer throws synchronously.
 */
function flushWriters (done, currentSpanWriter = spanWriter, currentEvalWriter = evalWriter) {
  let failed = false
  const deliveryTracker = createServerlessDeliveryTracker()
  const flush = writer => {
    try {
      if (deliveryTracker && writer) deliveryTracker.track(complete => writer.flush(complete))
      // Non-serverless flushes retain the existing writer behavior.
      else writer?.flush()
    } catch (error) {
      failed = true
      log.warn('Failed to flush LLMObs writer:', error.message)
    }
  }

  flush(currentSpanWriter)
  flush(currentEvalWriter)
  deliveryTracker?.waitForIdle(done)
  if (!deliveryTracker) done?.()
  return failed
}

function handleFlush () {
  const err = flushWriters() ? 'writer_flush_error' : ''
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
