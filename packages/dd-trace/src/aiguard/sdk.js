'use strict'

const log = require('../log')
const AIGuardClient = require('./client')
const { createEvaluationOutcome, EvaluationReporter } = require('./evaluation')
const { AIGuardAbortError } = require('./errors')
const NoopAIGuard = require('./noop')
const TAGS = require('./tags')

class AIGuard extends NoopAIGuard {
  #initialized
  #tracer
  #client
  #reporter
  #redactionEnabled
  #meta

  /**
   * @param {import('../tracer')} tracer - Tracer instance
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  constructor (tracer, config) {
    super()

    if (!config.DD_API_KEY || !config.DD_APP_KEY) {
      log.error('AIGuard: missing api and/or app keys, use env DD_API_KEY and DD_APP_KEY')
      this.#initialized = false
      return
    }
    this.#tracer = tracer
    this.#client = new AIGuardClient(config)
    this.#reporter = new EvaluationReporter(config)
    this.#redactionEnabled = config.experimental.aiguard.redactionEnabled
    this.#meta = { service: config.service, env: config.env }
    this.#initialized = true
  }

  evaluate (messages, opts) {
    if (!this.#initialized) {
      return super.evaluate(messages, opts)
    }
    const { block = true, source = TAGS.SOURCE_SDK, integration = TAGS.INTEGRATION_NONE, childOf } = opts ?? {}
    // Only pass `childOf` when truthy so `tracer.trace`'s default (`scope().active()`)
    // still applies for SDK callers that don't supply an explicit parent.
    const traceOpts = childOf ? { childOf } : {}
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
