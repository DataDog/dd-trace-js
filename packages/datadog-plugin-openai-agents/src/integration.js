'use strict'

const LLMObsTagger = require('../../dd-trace/src/llmobs/tagger')
const { getOpenAIModelProvider } = require('../../dd-trace/src/llmobs/plugins/openai/utils')
const {
  extractInputMessages,
  extractOutputMessages,
  extractMetrics,
  extractMetadata,
} = require('../../dd-trace/src/llmobs/plugins/openai-agents/utils')
const { AGENTS_ERROR_TYPE, applyError, deriveSpanName } = require('./util')

const COMPONENT = 'openai-agents'
const DEFAULT_MODEL_PROVIDER = 'openai'

const KIND_TO_SPAN_KIND = {
  agent: 'internal',
  tool: 'internal',
  task: 'internal',
  llm: 'client',
}

/**
 * @typedef {{
 *   spanId: string,
 *   traceId: string,
 *   currentTopLevelAgentSpanId?: string,
 *   currentTopLevelAgentName?: string,
 *   inputOaiSpan?: object,
 *   inputMessages?: Array<{ role: string, content: string }>,
 *   outputOaiSpan?: object,
 *   metadata?: Record<string, unknown>,
 *   groupId?: string,
 * }} LLMObsTraceInfo
 */

/**
 * Owns tracer/tagger refs, maps agents-core span ids → dd-trace spans, and
 * reconstructs workflow-level input/output from the first and last response
 * spans of the top-level agent.
 */
class OpenAIAgentsIntegration {
  #tracer
  #enabled = false
  #modelProvider = DEFAULT_MODEL_PROVIDER
  /**
   * LLMObs is gated independently of APM tracing: when llmobs.enabled is
   * false we keep emitting APM spans for the agent workflow but skip all
   * LLMObs tagging and the work that feeds it. The tagger is the single
   * source of truth for "is LLMObs on for this integration?".
   * @type {LLMObsTagger | undefined}
   */
  #tagger
  /** @type {Map<string, import('../../dd-trace/src/opentracing/span')>} */
  #oaiToDdSpan = new Map()
  /** @type {Map<string, LLMObsTraceInfo>} */
  #traceInfo = new Map()

  constructor ({ tracer, config } = {}) {
    this.#tracer = tracer
    this.#tagger = config?.llmobs?.enabled ? new LLMObsTagger(config, true) : undefined
  }

  get enabled () {
    return this.#enabled
  }

  setEnabled (enabled) {
    this.#enabled = enabled
  }

  /**
   * Update the model_provider tag based on the OpenAI-compatible client's
   * baseURL captured by the agents-openai instrumentation hook. Single-
   * provider-per-process is the assumed deployment shape; concurrent runs
   * against different providers will see last-write-wins on this field.
   *
   * @param {string} baseURL
   */
  setClientBaseURL (baseURL) {
    if (typeof baseURL !== 'string' || baseURL.length === 0) return
    this.#modelProvider = getOpenAIModelProvider(baseURL)
  }

  clearState () {
    // Finish any dd-trace spans still in-flight so we don't leak open traces
    // when agents-core's TracingProcessor.shutdown() runs (e.g., process
    // exiting mid-run).
    for (const ddSpan of this.#oaiToDdSpan.values()) {
      ddSpan.finish()
    }
    this.#oaiToDdSpan.clear()
    this.#traceInfo.clear()
  }

  // ── Trace lifecycle ─────────────────────────────────────────────────────────

  startTrace (oaiTrace) {
    const traceId = oaiTrace.traceId
    if (!traceId) return

    const name = oaiTrace.name || 'Agent workflow'
    const ddSpan = this.#tracer.startSpan(name, {
      tags: {
        component: COMPONENT,
        'span.kind': 'internal',
      },
    })

    this.#oaiToDdSpan.set(traceId, ddSpan)
    this.#traceInfo.set(traceId, {
      spanId: ddSpan.context().toSpanId(),
      traceId,
      groupId: oaiTrace.groupId || undefined,
      metadata: oaiTrace.metadata,
    })

    this.#tagger?.registerLLMObsSpan(ddSpan, {
      kind: 'workflow',
      name,
      integration: COMPONENT,
      sessionId: oaiTrace.groupId || undefined,
    })
  }

  endTrace (oaiTrace) {
    this.#completeWorkflowSpan(oaiTrace.traceId)
  }

  /**
   * Finish the workflow dd-trace span and clear its bookkeeping. Used by both
   * agents-core's normal `Trace.end()` path and the orphan-recovery path
   * (when `withTrace` skips its end callback because the body threw). When
   * `rootAgentSpan` is provided, its `error` field is reflected onto the
   * workflow span before finishing.
   *
   * @param {string | undefined} traceId
   * @param {object} [rootAgentSpan] - parentless oai-span that ended in error.
   */
  #completeWorkflowSpan (traceId, rootAgentSpan) {
    if (!traceId) return
    const ddSpan = this.#oaiToDdSpan.get(traceId)
    if (!ddSpan) return

    if (rootAgentSpan?.error) {
      ddSpan.setTag('error', true)
      ddSpan.setTag('error.type', AGENTS_ERROR_TYPE)
      if (rootAgentSpan.error.message) {
        ddSpan.setTag('error.message', rootAgentSpan.error.message)
      }
    }

    if (this.#tagger) this.#setTraceAttributes(ddSpan, traceId)
    ddSpan.finish()
    this.#oaiToDdSpan.delete(traceId)
    this.#traceInfo.delete(traceId)
  }

  // ── Span lifecycle ──────────────────────────────────────────────────────────

  startSpan (oaiSpan, llmobsKind) {
    const spanId = oaiSpan.spanId
    if (!spanId) return

    const parentSpan = this.#resolveParent(oaiSpan)
    const spanName = deriveSpanName(oaiSpan)

    const ddSpan = this.#tracer.startSpan(spanName, {
      childOf: parentSpan,
      tags: {
        component: COMPONENT,
        'span.kind': KIND_TO_SPAN_KIND[llmobsKind] ?? 'internal',
      },
    })

    this.#oaiToDdSpan.set(spanId, ddSpan)

    if (this.#tagger) {
      const llmobsOptions = {
        kind: llmobsKind,
        name: spanName,
        integration: COMPONENT,
        parent: parentSpan,
      }

      if (oaiSpan.spanData?.type === 'response') {
        // Model name only arrives with the response; tagged in
        // `#setResponseAttributes` once known. Model provider is resolved from
        // the agents-openai client's baseURL captured at getResponse time.
        llmobsOptions.modelProvider = this.#modelProvider
      }

      this.#tagger.registerLLMObsSpan(ddSpan, llmobsOptions)
      this.#updateTraceInfoInput(oaiSpan, spanName)
    }
  }

  endSpan (oaiSpan) {
    const spanId = oaiSpan.spanId
    const ddSpan = this.#oaiToDdSpan.get(spanId)
    if (!ddSpan) return

    applyError(ddSpan, oaiSpan)

    if (this.#tagger) {
      const spanData = oaiSpan.spanData
      switch (spanData?.type) {
        case 'response':
          this.#setResponseAttributes(ddSpan, oaiSpan)
          this.#updateTraceInfoOutput(oaiSpan)
          break
        case 'function':
          this.#tagger.tagTextIO(ddSpan, spanData.input ?? '', spanData.output ?? '')
          break
        case 'handoff':
          this.#tagger.tagTextIO(ddSpan, spanData.from_agent ?? '', spanData.to_agent ?? '')
          break
        case 'agent':
          this.#setAgentAttributes(ddSpan, oaiSpan)
          break
        case 'custom':
          if (spanData.data && typeof spanData.data === 'object') {
            this.#tagger.tagMetadata(ddSpan, spanData.data)
          }
          break
      }
    }

    ddSpan.finish()

    // agents-core's withTrace skips Trace.end() when its callback throws, so a
    // parentless span that errors is our last chance to finalize the workflow.
    if (oaiSpan.parentId == null) {
      this.#completeWorkflowSpan(oaiSpan.traceId, oaiSpan)
    }
    this.#oaiToDdSpan.delete(spanId)
  }

  // ── Per-type attribute setters ──────────────────────────────────────────────

  #setResponseAttributes (ddSpan, oaiSpan) {
    const response = oaiSpan.spanData?._response
    const input = oaiSpan.spanData?._input
    if (response?.model) {
      this.#tagger.tagModelName(ddSpan, response.model)
    }

    // Override the LLMObs span name to `{parent_agent_name} (LLM)` only when
    // the response is a direct child of the top-level agent (Python parity:
    // see `_llmobs_set_response_attributes` in dd-trace-py). For bare
    // `withResponseSpan` calls outside a `Runner.run()` flow the default
    // name (`openai_agents.response`) stays.
    const parentAgentName = this.#llmSpanParentAgentName(oaiSpan)
    if (parentAgentName) {
      this.#tagger.setName(ddSpan, `${parentAgentName} (LLM)`)
    }

    // Always tag LLM I/O so the LLMObs event shape is consistent across
    // happy/error paths. The extract* helpers emit placeholder messages
    // when their source is absent.
    const inputMessages = extractInputMessages(input, response?.instructions)
    this.#tagger.tagLLMIO(ddSpan, inputMessages, extractOutputMessages(response))

    // Cache messages for the workflow span's trace-level input (Python
    // parity: last message of the first response under the top-level agent).
    // Avoids re-running extractInputMessages in #setTraceAttributes.
    const info = this.#traceInfo.get(oaiSpan.traceId)
    if (info && info.inputOaiSpan === oaiSpan) {
      info.inputMessages = inputMessages
    }

    if (response) {
      const metrics = extractMetrics(response)
      if (metrics) this.#tagger.tagMetrics(ddSpan, metrics)

      const metadata = extractMetadata(response)
      if (metadata) this.#tagger.tagMetadata(ddSpan, metadata)
    }
  }

  /**
   * If this response span's parent is the top-level agent span of the trace,
   * return that agent's dd-trace span name. Used to set the LLMObs span name
   * to `${agentName} (LLM)` (Python parity).
   *
   * @param {object} oaiSpan
   * @returns {string | undefined}
   */
  #llmSpanParentAgentName (oaiSpan) {
    const traceInfo = this.#traceInfo.get(oaiSpan.traceId)
    if (!traceInfo?.currentTopLevelAgentSpanId) return
    if (oaiSpan.parentId !== traceInfo.currentTopLevelAgentSpanId) return
    return traceInfo.currentTopLevelAgentName
  }

  #setAgentAttributes (ddSpan, oaiSpan) {
    const spanData = oaiSpan.spanData
    let metadata
    if (Array.isArray(spanData?.handoffs) && spanData.handoffs.length > 0) {
      metadata = { handoffs: spanData.handoffs }
    }
    if (Array.isArray(spanData?.tools) && spanData.tools.length > 0) {
      metadata ??= {}
      metadata.tools = spanData.tools
    }
    if (spanData?.output_type) {
      metadata ??= {}
      metadata.output_type = spanData.output_type
    }
    if (metadata) this.#tagger.tagMetadata(ddSpan, metadata)
  }

  #setTraceAttributes (ddSpan, traceId) {
    const info = this.#traceInfo.get(traceId)
    if (!info) return

    // Workflow-level input is the last input message of the first response
    // span under the top-level agent; output is `response.output_text` of
    // the last response span. Matches dd-trace-py's
    // `OaiSpanAdapter.llmobs_trace_input` / `response_output_text`. The
    // input messages were cached during #setResponseAttributes.
    const lastInputMessage = info.inputMessages?.at(-1)
    const inputValue = typeof lastInputMessage?.content === 'string' ? lastInputMessage.content : ''
    const outputValue = info.outputOaiSpan?.spanData?._response?.output_text ?? ''

    this.#tagger.tagTextIO(ddSpan, inputValue, outputValue)

    if (info.metadata && Object.keys(info.metadata).length > 0) {
      this.#tagger.tagMetadata(ddSpan, info.metadata)
    }
  }

  // ── Trace-info reconstruction (Python parity) ───────────────────────────────

  #updateTraceInfoInput (oaiSpan, spanName) {
    const info = this.#traceInfo.get(oaiSpan.traceId)
    if (!info) return

    const parentId = oaiSpan.parentId
    const type = oaiSpan.spanData?.type

    // Identify the first top-level agent span under the root trace and
    // stash its display name so `${agentName} (LLM)` doesn't have to read
    // the dd-trace span context's private fields later.
    if (type === 'agent' && parentId == null) {
      info.currentTopLevelAgentSpanId = oaiSpan.spanId
      info.currentTopLevelAgentName = spanName
    }

    // Capture the first response span whose parent is the top-level agent
    // as the workflow-level input source.
    if (
      type === 'response' &&
      parentId &&
      !info.inputOaiSpan &&
      parentId === info.currentTopLevelAgentSpanId
    ) {
      info.inputOaiSpan = oaiSpan
    }
  }

  #updateTraceInfoOutput (oaiSpan) {
    const info = this.#traceInfo.get(oaiSpan.traceId)
    if (!info) return

    if (
      oaiSpan.parentId &&
      info.currentTopLevelAgentSpanId &&
      oaiSpan.parentId === info.currentTopLevelAgentSpanId
    ) {
      info.outputOaiSpan = oaiSpan
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  #resolveParent (oaiSpan) {
    const parentId = oaiSpan.parentId
    const traceId = oaiSpan.traceId
    if (parentId) {
      const parent = this.#oaiToDdSpan.get(parentId)
      if (parent) return parent
    }
    if (traceId) {
      const root = this.#oaiToDdSpan.get(traceId)
      if (root) return root
    }
  }
}

module.exports = { OpenAIAgentsIntegration }
