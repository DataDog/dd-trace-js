'use strict'

const log = require('../../dd-trace/src/log')

const SPAN_KIND_BY_TYPE = {
  agent: 'agent',
  function: 'tool',
  handoff: 'tool',
  response: 'llm',
  guardrail: 'task',
  custom: 'task',
}

/**
 * dd-trace-js implementation of the agents-core `TracingProcessor` interface.
 * Registered via `addTraceProcessor(new DDOpenAIAgentsProcessor(integration))` inside
 * the `@openai/agents-core` module load hook. Mirrors Python's LLMObsTraceProcessor.
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
  constructor (integration) {
    this._integration = integration
  }

  onTraceStart (oaiTrace) {
    if (!this._integration.enabled) return Promise.resolve()
    try {
      this._integration.startTrace(oaiTrace)
    } catch (err) {
      log.warn('[openai-agents] onTraceStart failed: %s', err)
    }
    return Promise.resolve()
  }

  onTraceEnd (oaiTrace) {
    if (!this._integration.enabled) return Promise.resolve()
    try {
      this._integration.endTrace(oaiTrace)
    } catch (err) {
      log.warn('[openai-agents] onTraceEnd failed: %s', err)
    }
    return Promise.resolve()
  }

  onSpanStart (oaiSpan) {
    if (!this._integration.enabled) return Promise.resolve()
    if (!oaiSpan?.spanData) return Promise.resolve() // guard NoopSpan
    const kind = SPAN_KIND_BY_TYPE[oaiSpan.spanData.type]
    if (!kind) return Promise.resolve() // span types without an LLMObs kind are not traced
    try {
      this._integration.startSpan(oaiSpan, kind)
    } catch (err) {
      log.warn('[openai-agents] onSpanStart failed: %s', err)
    }
    return Promise.resolve()
  }

  onSpanEnd (oaiSpan) {
    if (!this._integration.enabled) return Promise.resolve()
    if (!oaiSpan?.spanData) return Promise.resolve()
    try {
      this._integration.endSpan(oaiSpan)
    } catch (err) {
      log.warn('[openai-agents] onSpanEnd failed: %s', err)
    }
    return Promise.resolve()
  }

  forceFlush () {
    // dd-trace exports on its own schedule; nothing to force here.
    return Promise.resolve()
  }

  shutdown () {
    try {
      this._integration.clearState()
    } catch (err) {
      log.warn('[openai-agents] shutdown cleanup failed: %s', err)
    }
    return Promise.resolve()
  }
}

module.exports = { DDOpenAIAgentsProcessor }
