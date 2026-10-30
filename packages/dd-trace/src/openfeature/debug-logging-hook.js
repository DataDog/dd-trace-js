'use strict'

const { inspect } = require('node:util')

const log = require('../log')
const { debugChannel } = require('../log/channels')

// Debug output must show raw values and contexts in full rather than inspect's default depth and length limits.
const INSPECT_OPTIONS = {
  breakLength: Infinity,
  compact: true,
  customInspect: false,
  depth: Infinity,
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
}

const PROVIDER_RESOLUTION = 'datadog.debugLogging.providerResolution'

/**
 * @typedef {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1} UniversalFlagConfiguration
 */

/**
 * Logs full evaluation details under DD_TRACE_DEBUG, matching EvalMetricsHook's use of `finally`.
 */
class DebugLoggingHook {
  #getConfiguration

  /**
   * @param {() => UniversalFlagConfiguration | undefined} [getConfiguration] - Current configuration
   */
  constructor (getConfiguration) {
    this.#getConfiguration = getConfiguration
  }

  /**
   * Keeps the provider resolution so `finally` can tell it apart from a result replaced by a failing later hook.
   *
   * @param {{ hookData?: { set: (key: string, value: unknown) => void } }} hookContext - Hook context
   * @param {object} evaluationDetails - Provider resolution details
   */
  after (hookContext, evaluationDetails) {
    if (!debugChannel.hasSubscribers) return
    // A formatted snapshot preserves primitive fields and nested values before application hooks can mutate them.
    hookContext?.hookData?.set(PROVIDER_RESOLUTION, inspect(evaluationDetails, INSPECT_OPTIONS))
  }

  /**
   * @param {{
   *   flagKey: string,
   *   flagValueType?: string,
   *   defaultValue?: unknown,
   *   context?: object,
   *   hookData?: { get: (key: string) => unknown }
   * }} hookContext - Hook context containing the flag key and evaluation inputs
   * @param {object} evaluationDetails - Evaluation details observed by this hook
   */
  finally (hookContext, evaluationDetails) {
    try {
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.debug(() => {
        const configuration = this.#getConfiguration?.()
        const configurationIdentity = configuration
          ? `configuration observed at logging time: createdAt=${configuration.createdAt}, ` +
            `configuration environment=${configuration.environment?.name}`
          : 'no configuration observed at logging time'
        const details = inspect(evaluationDetails, INSPECT_OPTIONS)
        let message = `Feature Flags: evaluated ${hookContext?.flagKey} (type=${hookContext?.flagValueType}, ` +
          `default=${inspect(hookContext?.defaultValue, INSPECT_OPTIONS)}, ` +
          `context=${inspect(hookContext?.context, INSPECT_OPTIONS)}, ${configurationIdentity}): ` +
          `finally hook saw ${details}`
        const resolution = hookContext?.hookData?.get(PROVIDER_RESOLUTION)
        if (resolution !== undefined && resolution !== details) {
          message += `; earlier resolution seen by provider hook: ${resolution}`
        }
        return message
      })
    } catch (error) {
      try {
        // Defense in depth; the OpenFeature SDK already guards finally hooks.
        log.warn('DebugLoggingHook: error in finally hook: %s', error.message)
      } catch { /* logging failure must not crash evaluation */ }
    }
  }
}

module.exports = DebugLoggingHook
