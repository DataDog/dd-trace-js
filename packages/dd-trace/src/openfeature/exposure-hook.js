'use strict'

const log = require('../log')

const METADATA_FEATURE_PREFIX = '__dd_feature.'
const METADATA_ALLOCATION_KEY = '__dd_allocation_key'
const METADATA_DO_LOG = '__dd_do_log'
const METADATA_EXPOSURE_CACHE_HIT = '__dd_exposure_cache_hit'

/**
 * An OpenFeature hook that hands each completed flag evaluation to a callback,
 * with the Datadog exposure decision, so an application can record exposures in
 * its own data store.
 *
 * This hook is optional. The provider puts the same data in the flag metadata,
 * so any OpenFeature hook can read it. This class reads it for you.
 *
 * Register it with `OpenFeature.addHooks(new ExposureHook(callback))` or on a
 * client. The callback runs for every evaluation, including errors and repeats.
 * Use `shouldSend()` to keep the new or changed exposures.
 *
 * When the provider's own hooks run and `DD_FEATURE_FLAGS_EXPOSURES_DATADOG_LOGGING_ENABLED`
 * is on, these are exactly the exposures that Datadog sends. With that setting
 * off, Datadog receives no exposures, and `shouldSend()` gives the same results.
 *
 * The callback runs on the evaluation thread: hand the data to a background
 * queue instead of doing I/O in the callback. An exception from the callback
 * does not affect the evaluation. The first one is logged at warn level, later
 * ones at debug level.
 */
class ExposureHook {
  #callback
  #warned = false

  /**
   * @param {(evaluation: ExposureEvaluation) => void} callback
   */
  constructor (callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('ExposureHook requires a callback function')
    }
    this.#callback = callback
  }

  /**
   * Runs in the final hook stage, so a later hook's error is seen.
   *
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   */
  finally (hookContext, evaluationDetails) {
    if (evaluationDetails == null) return
    try {
      this.#callback(new ExposureEvaluation(hookContext, evaluationDetails))
    } catch (error) {
      if (this.#warned) {
        log.debug('Exposure callback failed', error)
      } else {
        this.#warned = true
        log.warn('Exposure callback failed; later failures are logged at debug level', error)
      }
    }
  }
}

/** A completed evaluation and its Datadog exposure decision. */
class ExposureEvaluation {
  /** @type {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} */
  #details

  /** @type {import('@openfeature/core').EvaluationContext | undefined} */
  #context

  /**
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} details
   */
  constructor (hookContext, details) {
    this.flagKey = hookContext?.flagKey ?? details.flagKey
    this.#details = details
    // A wrapper may expose an unreadable context; the exposure decision below never reads it.
    try {
      this.#context = hookContext?.context
    } catch {
      this.#context = undefined
    }
  }

  /** The flag key, variant, value, error and flag metadata of the evaluation. */
  get details () {
    return this.#details
  }

  /** The selected variant key, or undefined when the default value was returned. */
  get variant () {
    return this.#details.variant
  }

  /** The key of the selected allocation, or undefined when none was selected. */
  get allocation () {
    const allocationKey = this.#details.flagMetadata?.[METADATA_ALLOCATION_KEY]
    return typeof allocationKey === 'string' ? allocationKey : undefined
  }

  /** The evaluation context, including the targeting key. */
  get context () {
    return this.#context
  }

  /** The targeting key of the evaluation context, if readable. */
  get targetingKey () {
    const targetingKey = this.#context?.targetingKey
    return typeof targetingKey === 'string' ? targetingKey : undefined
  }

  /**
   * True when the evaluation succeeded and selected an allocation that logs
   * exposures, whether or not this subject was already exposed.
   */
  isExposure () {
    return this.#details.errorCode === undefined &&
      this.#details.variant != null &&
      typeof this.allocation === 'string' &&
      this.#details.flagMetadata?.[METADATA_DO_LOG] === true
  }

  /**
   * True when this exposure repeats one already recorded for this subject:
   * same allocation, variant and serial id. False for a new or changed
   * exposure, and for an evaluation that is not an exposure.
   */
  isCacheHit () {
    return this.isExposure() && this.#details.flagMetadata?.[METADATA_EXPOSURE_CACHE_HIT] === true
  }

  /**
   * True for a new or changed exposure: the decision the provider uses for
   * Datadog.
   */
  shouldSend () {
    return this.isExposure() && this.#details.flagMetadata?.[METADATA_EXPOSURE_CACHE_HIT] === false
  }

  /**
   * The HOOK features of the selected split, such as `holdout.key` and
   * `holdout.assignment_group`. Values are a string, number or boolean.
   * Read-only; empty when the split has none.
   */
  getFeatures () {
    const metadata = this.#details.flagMetadata
    const features = {}
    if (metadata != null) {
      for (const [key, value] of Object.entries(metadata)) {
        if (!key.startsWith(METADATA_FEATURE_PREFIX)) continue
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
        features[key.slice(METADATA_FEATURE_PREFIX.length)] = value
      }
    }
    return Object.freeze(features)
  }
}

module.exports = {
  ExposureEvaluation,
  ExposureHook,
}
