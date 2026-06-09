'use strict'

const log = require('../../dd-trace/src/log')

const SPAN_KIND_BY_TYPE = {
  agent: 'agent',
  function: 'tool',
  handoff: 'tool',
  guardrail: 'task',
  custom: 'task',
}

// Lifecycle methods are awaited by agents-core. Share one resolved Promise
// across every callback so we don't allocate per span event.
const RESOLVED = Promise.resolve()

/**
 * dd-trace-js implementation of the agents-core `TracingProcessor` interface.
 * Registered via `addTraceProcessor(new DDOpenAIAgentsProcessor(integration))` inside
 * the `@openai/agents` module load hook. Mirrors Python's LLMObsTraceProcessor.
 *
 * Each agents-core Span / Trace lifecycle event turns into a dd-trace span
 * (APM + LLMObs-annotated) keyed off the agents-core spanId / traceId. Parent
 * hierarchy is resolved through the agents-core parentId chain, which gives us
 * correct multi-agent handoff nesting that ctx-argument capture cannot provide.
 *
 * agents-core awaits the lifecycle methods, so each one returns a settled
 * Promise even though the work is synchronous.
 */
class DDOpenAIAgentsProcessor {
  /**
   * @param {() => (import('./integration').OpenAIAgentsIntegration | undefined)} getIntegration - Lazy accessor for the
   *   current OpenAIAgentsIntegration singleton. Read on each lifecycle event
   *   so re-instantiating the plugin doesn't strand the processor against an
   *   old integration reference inside agents-core.
   */
  constructor (getIntegration) {
    this._getIntegration = getIntegration
  }

  onTraceStart (oaiTrace) {
    const integration = this._getIntegration()
    if (!integration?.enabled) return RESOLVED
    try {
      integration.startTrace(oaiTrace)
    } catch (err) {
      log.warn('[openai-agents] onTraceStart failed: %s', err)
    }
    return RESOLVED
  }

  onTraceEnd (oaiTrace) {
    const integration = this._getIntegration()
    if (!integration?.enabled) return RESOLVED
    try {
      integration.endTrace(oaiTrace)
    } catch (err) {
      log.warn('[openai-agents] onTraceEnd failed: %s', err)
    }
    return RESOLVED
  }

  onSpanStart (oaiSpan) {
    const integration = this._getIntegration()
    if (!integration?.enabled) return RESOLVED
    if (!oaiSpan?.spanData) return RESOLVED // guard NoopSpan
    const kind = SPAN_KIND_BY_TYPE[oaiSpan.spanData.type]
    if (!kind) return RESOLVED // span types without an LLMObs kind are not traced
    try {
      integration.startSpan(oaiSpan, kind)
    } catch (err) {
      log.warn('[openai-agents] onSpanStart failed: %s', err)
    }
    return RESOLVED
  }

  onSpanEnd (oaiSpan) {
    const integration = this._getIntegration()
    if (!integration?.enabled) return RESOLVED
    if (!oaiSpan?.spanData) return RESOLVED
    try {
      integration.endSpan(oaiSpan)
    } catch (err) {
      log.warn('[openai-agents] onSpanEnd failed: %s', err)
    }
    return RESOLVED
  }

  forceFlush () {
    // dd-trace exports on its own schedule; nothing to force here.
    return RESOLVED
  }

  shutdown () {
    const integration = this._getIntegration()
    if (!integration) return RESOLVED
    try {
      integration.clearState()
    } catch (err) {
      log.warn('[openai-agents] shutdown cleanup failed: %s', err)
    }
    return RESOLVED
  }
}

module.exports = { DDOpenAIAgentsProcessor }
