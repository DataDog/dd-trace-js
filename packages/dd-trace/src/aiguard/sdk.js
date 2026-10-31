'use strict'

const log = require('../log')
const AIGuardClient = require('./client')
const { createEvaluationOutcome, EvaluationReporter } = require('./evaluation')
const { AIGuardAbortError } = require('./errors')
const NoopAIGuard = require('./noop')
const TAGS = require('./tags')

/**
 * Returns a client option when it is a non-empty string, so that other values use the global configuration.
 *
 * @param {import('../../../../index').aiguard.ClientOptions|undefined} options
 * @param {keyof import('../../../../index').aiguard.ClientOptions} name
 * @returns {string|undefined}
 */
function getOption (options, name) {
  const value = options?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

class AIGuard extends NoopAIGuard {
  #initialized
  #tracer
  #config
  #client
  #reporter
  #redactionEnabled
  #meta
  #spanTags

  /**
   * @param {import('../tracer')} tracer - Tracer instance
   * @param {import('../config/config-base')} config - Tracer configuration
   * @param {import('../../../../index').aiguard.ClientOptions} [options] - Client settings that replace the
   *   global configuration
   */
  constructor (tracer, config, options) {
    super()

    // Kept even without keys, so createClient() can still build clients with their own keys.
    this.#tracer = tracer
    this.#config = config

    const apiKey = getOption(options, 'apiKey')
    const appKey = getOption(options, 'appKey')
    if (!(apiKey ?? config.DD_API_KEY) || !(appKey ?? config.DD_APP_KEY)) {
      log.error(options
        ? 'AIGuard: missing api and/or app keys, use the apiKey and appKey options or env DD_API_KEY and DD_APP_KEY'
        : 'AIGuard: missing api and/or app keys, use env DD_API_KEY and DD_APP_KEY')
      this.#initialized = false
      return
    }

    const service = getOption(options, 'service')
    const env = getOption(options, 'env')
    this.#client = new AIGuardClient(config, { apiKey, appKey, site: getOption(options, 'site') })
    this.#reporter = new EvaluationReporter(config)
    this.#redactionEnabled = config.aiguard.DD_AI_GUARD_REDACTION_ENABLED
    this.#meta = { service: service ?? config.service, env: env ?? config.env }
    if (service !== undefined || env !== undefined) {
      this.#spanTags = {}
      if (service !== undefined) this.#spanTags.service = service
      if (env !== undefined) this.#spanTags.env = env
    }
    this.#initialized = true
  }

  /**
   * Creates a client with its own keys, site, service and env. Unset options use the global configuration.
   *
   * @param {import('../../../../index').aiguard.ClientOptions} [options]
   * @returns {AIGuard}
   */
  createClient (options) {
    return new AIGuard(this.#tracer, this.#config, options ?? {})
  }

  evaluate (messages, opts) {
    if (!this.#initialized) {
      return super.evaluate(messages, opts)
    }
    const { block = true, source = TAGS.SOURCE_SDK, integration = TAGS.INTEGRATION_NONE, childOf } = opts ?? {}
    // Only pass `childOf` when truthy so `tracer.trace`'s default (`scope().active()`)
    // still applies for SDK callers that don't supply an explicit parent.
    const traceOpts = childOf ? { childOf } : {}
    // A copy for each span, because the tracer can change the tags object it receives.
    if (this.#spanTags) traceOpts.tags = { ...this.#spanTags }
    return this.#tracer.trace(TAGS.RESOURCE, traceOpts, async (span) => {
      const report = this.#reporter.start(span, messages, { source, integration })
      let evaluation
      try {
        evaluation = await this.#client.evaluate(report.messages, this.#meta)
      } catch (error) {
        this.#reporter.fail(report, error.telemetryType ?? TAGS.ERROR_TYPE_CLIENT)
        throw error
      }

      const outcome = createEvaluationOutcome(report.messages, evaluation, {
        block,
        redactionEnabled: this.#redactionEnabled,
      })
      this.#reporter.finish(report, outcome)

      if (outcome.shouldBlock) {
        const { reason, tags, tagProbabilities, sds } = outcome.result
        throw new AIGuardAbortError(reason, tags, tagProbabilities, sds)
      }

      return outcome.result
    })
  }
}

module.exports = AIGuard
