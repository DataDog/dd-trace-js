'use strict'

const log = require('../log')

const METER_NAME = 'dd-trace-js/openfeature'
const COUNTER_NAME = 'feature_flag.evaluations'
const COUNTER_DESCRIPTION = 'Number of feature flag evaluations'
const COUNTER_UNIT = '{evaluation}'

/**
 * OpenFeature hook that tracks feature flag evaluation metrics using an
 * OpenTelemetry counter.
 *
 * Implements the OpenFeature `finally` hook interface so it can be pushed
 * directly onto a provider's `hooks` array. We use the `finally` stage
 * (not diagnostic channels inside the provider's `resolve*` methods) because
 * the OpenFeature SDK short-circuits before calling the provider when it is in
 * NOT_READY state; the `finally` hook still fires, ensuring all evaluations are
 * captured. It also catches type-mismatch errors detected by the SDK client
 * after the provider returns.
 *
 * The counter is created lazily on the first successful `finally()` call rather
 * than in the constructor. This is necessary because `FlaggingProvider` is
 * constructed eagerly by `proxy.js#updateTracing()`, which runs *before*
 * `initializeOpenTelemetryMetrics()` sets the global OTel meter provider.
 * Calling `getMeter()` in the constructor would return the noop meter and
 * produce a noop counter that silently discards all measurements. By deferring
 * to `finally()` time we give the meter provider a chance to be set up first.
 *
 * If counter creation fails (e.g. the OTel API is not yet available), the call
 * is silently skipped and retried on the next `finally()` invocation.
 *
 * When `config.DD_METRICS_OTEL_ENABLED` is false, `finally()` is always a no-op.
 */
class EvalMetricsHook {
  #enabled = false
  #counter = null

  /**
   * @param {import('../config')} config - Tracer configuration object
   */
  constructor (config) {
    this.#enabled = config.DD_METRICS_OTEL_ENABLED === true
  }

  /**
   * Returns the OTel counter, creating it on first successful call.
   * Returns `null` if counter creation fails; will retry on next call.
   *
   * @returns {import('@opentelemetry/api').Counter | null}
   */
  #getCounter () {
    if (this.#counter) return this.#counter

    try {
      const { metrics } = require('@opentelemetry/api')
      const meter = metrics.getMeter(METER_NAME)
      this.#counter = meter.createCounter(COUNTER_NAME, {
        description: COUNTER_DESCRIPTION,
        unit: COUNTER_UNIT,
      })
    } catch (e) {
      log.warn('EvalMetricsHook: failed to create counter: %s', e.message)
    }

    return this.#counter
  }

  /**
   * Called by the OpenFeature SDK after every flag evaluation (success or error).
   *
   * @param {{ flagKey: string }} hookContext - Hook context containing the flag key
   * @param {{ variant?: string, reason?: string, errorCode?: string, flagMetadata?: object }} evaluationDetails
   *   - Full evaluation details
   * @returns {void}
   */
  finally (hookContext, evaluationDetails) {
    if (!this.#enabled) return

    const counter = this.#getCounter()
    if (!counter) return

    const attributes = {
      'feature_flag.key': hookContext?.flagKey ?? '',
      'feature_flag.result.variant': evaluationDetails?.variant ?? '',
      'feature_flag.result.reason': evaluationDetails?.reason?.toLowerCase() ?? 'unknown',
    }

    const errorCode = evaluationDetails?.errorCode
    if (errorCode) {
      attributes['error.type'] = errorCode.toLowerCase()
    }

    const allocationKey = evaluationDetails?.flagMetadata?.allocationKey
    if (allocationKey) {
      attributes['feature_flag.result.allocation_key'] = allocationKey
    }

    counter.add(1, attributes)
  }
}

module.exports = EvalMetricsHook
