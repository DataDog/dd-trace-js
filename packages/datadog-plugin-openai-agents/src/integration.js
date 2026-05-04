'use strict'

const { NAME } = require('../../dd-trace/src/llmobs/constants/tags')
const {
  extractInputMessages,
  extractOutputMessages,
  extractMetrics,
  extractMetadata,
} = require('../../dd-trace/src/llmobs/plugins/openai-agents/utils')

const COMPONENT = 'openai-agents'
const AGENTS_ERROR_TYPE = 'AgentsCoreError'

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
 *   inputOaiSpan?: object,
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
  constructor ({ tracer, tagger, config } = {}) {
    this._tracer = tracer
    this._tagger = tagger
    this._config = config
    this._enabled = false

    /** @type {Map<string, import('../../dd-trace/src/opentracing/span')>} */
    this._oaiToDdSpan = new Map()
    /** @type {Map<string, LLMObsTraceInfo>} */
    this._traceInfo = new Map()
  }

  get enabled () {
    return this._enabled && !!this._tracer
  }

  setEnabled (enabled) {
    this._enabled = enabled
  }

  clearState () {
    this._oaiToDdSpan.clear()
    this._traceInfo.clear()
  }

  // ── Trace lifecycle ─────────────────────────────────────────────────────────

  startTrace (oaiTrace) {
    const traceId = oaiTrace.traceId
    if (!traceId) return

    const name = oaiTrace.name || 'Agent workflow'
    const ddSpan = this._tracer.startSpan(name, {
      tags: {
        component: COMPONENT,
        'span.kind': 'internal',
      },
    })

    this._oaiToDdSpan.set(traceId, ddSpan)
    this._traceInfo.set(traceId, {
      spanId: ddSpan.context().toSpanId(),
      traceId,
      groupId: oaiTrace.groupId || undefined,
      metadata: oaiTrace.metadata,
    })

    this._tagger.registerLLMObsSpan(ddSpan, {
      kind: 'workflow',
      name,
      integration: COMPONENT,
      sessionId: oaiTrace.groupId || undefined,
    })
  }

  endTrace (oaiTrace) {
    const traceId = oaiTrace.traceId
    const ddSpan = this._oaiToDdSpan.get(traceId)
    if (!ddSpan) return

    this._setTraceAttributes(ddSpan, traceId)

    ddSpan.finish()
    this._oaiToDdSpan.delete(traceId)
    this._traceInfo.delete(traceId)
  }

  /**
   * Finalize the workflow span when agents-core's `Trace.end()` won't run —
   * e.g., `run()` throws and `withTrace` skips its end callback.
   */
  _finalizeTraceIfOrphaned (traceId, rootAgentSpan) {
    if (!traceId) return
    const ddSpan = this._oaiToDdSpan.get(traceId)
    if (!ddSpan) return

    if (rootAgentSpan?.error) {
      ddSpan.setTag('error', true)
      ddSpan.setTag('error.type', AGENTS_ERROR_TYPE)
      if (rootAgentSpan.error.message) {
        ddSpan.setTag('error.message', rootAgentSpan.error.message)
      }
    }

    this._setTraceAttributes(ddSpan, traceId)
    ddSpan.finish()
    this._oaiToDdSpan.delete(traceId)
    this._traceInfo.delete(traceId)
  }

  // ── Span lifecycle ──────────────────────────────────────────────────────────

  startSpan (oaiSpan, llmobsKind) {
    const spanId = oaiSpan.spanId
    if (!spanId) return

    const parentSpan = this._resolveParent(oaiSpan)
    const spanName = this._deriveSpanName(oaiSpan)

    const ddSpan = this._tracer.startSpan(spanName, {
      childOf: parentSpan,
      tags: {
        component: COMPONENT,
        'span.kind': KIND_TO_SPAN_KIND[llmobsKind] ?? 'internal',
      },
    })

    this._oaiToDdSpan.set(spanId, ddSpan)

    const llmobsOptions = {
      kind: llmobsKind,
      name: spanName,
      integration: COMPONENT,
      parent: parentSpan,
    }

    if (oaiSpan.spanData?.type === 'response') {
      // Model provider is always 'openai' for this integration; the actual
      // model name only arrives with the response, so we leave modelName
      // blank here and tag it in `_setResponseAttributes` once known.
      llmobsOptions.modelProvider = 'openai'
      const modelName = this._responseModelName(oaiSpan)
      if (modelName) llmobsOptions.modelName = modelName
    }

    this._tagger.registerLLMObsSpan(ddSpan, llmobsOptions)

    this._updateTraceInfoInput(oaiSpan)
  }

  endSpan (oaiSpan) {
    const spanId = oaiSpan.spanId
    const ddSpan = this._oaiToDdSpan.get(spanId)
    if (!ddSpan) return

    this._applyError(ddSpan, oaiSpan)

    const spanData = oaiSpan.spanData
    switch (spanData?.type) {
      case 'response':
        this._setResponseAttributes(ddSpan, oaiSpan)
        this._updateTraceInfoOutput(oaiSpan)
        break
      case 'function':
        this._tagger.tagTextIO(ddSpan, spanData.input ?? '', spanData.output ?? '')
        break
      case 'handoff':
        this._tagger.tagTextIO(ddSpan, spanData.from_agent ?? '', spanData.to_agent ?? '')
        break
      case 'agent':
        this._setAgentAttributes(ddSpan, oaiSpan)
        break
      case 'custom':
        if (spanData.data && typeof spanData.data === 'object') {
          this._tagger.tagMetadata(ddSpan, spanData.data)
        }
        break
    }

    ddSpan.finish()

    // agents-core's withTrace skips Trace.end() when its callback throws, so a
    // parentless span that errors is our last chance to finalize the workflow.
    if (oaiSpan.parentId == null) {
      this._finalizeTraceIfOrphaned(oaiSpan.traceId, oaiSpan)
    }
    this._oaiToDdSpan.delete(spanId)
  }

  // ── Per-type attribute setters ──────────────────────────────────────────────

  _setResponseAttributes (ddSpan, oaiSpan) {
    const response = oaiSpan.spanData?._response
    const input = oaiSpan.spanData?._input
    if (!response && input == null) return

    // Model name only becomes available once the response lands; we record
    // the API value as-is (matching Python's openai-agents integration —
    // e.g., `gpt-4o-2024-08-06`, not `gpt-4o`).
    if (response?.model) {
      this._tagger.tagModelName(ddSpan, response.model)
    }

    // Override the LLMObs span name to `{parent_agent_name} (LLM)` only when
    // the response is a direct child of the top-level agent (Python parity:
    // see `_llmobs_set_response_attributes` in dd-trace-py). For bare
    // `withResponseSpan` calls outside a `Runner.run()` flow the default
    // name (`openai_agents.response`) stays.
    const parentAgentName = this._llmSpanParentAgentName(oaiSpan)
    if (parentAgentName) {
      this._tagger._setTag(ddSpan, NAME, `${parentAgentName} (LLM)`)
    }

    // Always tag LLM I/O on response-type spans so the LLMObs event shape is
    // consistent across happy/error paths — the tagger gives us
    // `input.messages` / `output.messages` keys we can assert against.
    const inputMessages = input == null ? [] : extractInputMessages(input, response?.instructions)
    const outputMessages = response ? extractOutputMessages(response) : [{ content: '', role: '' }]
    this._tagger.tagLLMIO(ddSpan, inputMessages, outputMessages)

    if (response) {
      const metrics = extractMetrics(response)
      if (Object.keys(metrics).length > 0) {
        this._tagger.tagMetrics(ddSpan, metrics)
      }

      const metadata = extractMetadata(response)
      if (Object.keys(metadata).length > 0) {
        this._tagger.tagMetadata(ddSpan, metadata)
      }
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
  _llmSpanParentAgentName (oaiSpan) {
    const traceInfo = this._traceInfo.get(oaiSpan.traceId)
    if (!traceInfo?.currentTopLevelAgentSpanId) return
    if (oaiSpan.parentId !== traceInfo.currentTopLevelAgentSpanId) return
    const parentDdSpan = this._oaiToDdSpan.get(oaiSpan.parentId)
    return parentDdSpan?.context()._name
  }

  _setAgentAttributes (ddSpan, oaiSpan) {
    const spanData = oaiSpan.spanData
    const metadata = {}
    if (Array.isArray(spanData?.handoffs) && spanData.handoffs.length > 0) {
      metadata.handoffs = spanData.handoffs
    }
    if (Array.isArray(spanData?.tools) && spanData.tools.length > 0) {
      metadata.tools = spanData.tools
    }
    if (spanData?.output_type) metadata.output_type = spanData.output_type
    if (Object.keys(metadata).length > 0) {
      this._tagger.tagMetadata(ddSpan, metadata)
    }
  }

  _setTraceAttributes (ddSpan, traceId) {
    const info = this._traceInfo.get(traceId)
    if (!info) return

    // Workflow-level input is the last input message of the first response
    // span under the top-level agent; output is `response.output_text` of
    // the last response span. Matches dd-trace-py's
    // `OaiSpanAdapter.llmobs_trace_input` / `response_output_text`.
    const inputValue = info.inputOaiSpan ? this._traceInputFrom(info.inputOaiSpan) : ''
    const outputValue = info.outputOaiSpan?.spanData?._response?.output_text ?? ''

    this._tagger.tagTextIO(ddSpan, inputValue, outputValue)

    if (info.metadata && Object.keys(info.metadata).length > 0) {
      this._tagger.tagMetadata(ddSpan, info.metadata)
    }
  }

  /**
   * Extracts the workflow-level input value from a response oai-span: the
   * content of the last user message in its reconstructed input messages.
   *
   * @param {object} oaiSpan
   * @returns {string}
   */
  _traceInputFrom (oaiSpan) {
    const input = oaiSpan.spanData?._input
    if (input == null) return ''
    const response = oaiSpan.spanData?._response
    const messages = extractInputMessages(input, response?.instructions)
    const lastMessage = messages?.at(-1)
    return typeof lastMessage?.content === 'string' ? lastMessage.content : ''
  }

  // ── Trace-info reconstruction (Python parity) ───────────────────────────────

  _updateTraceInfoInput (oaiSpan) {
    const info = this._traceInfo.get(oaiSpan.traceId)
    if (!info) return

    const parentId = oaiSpan.parentId
    const type = oaiSpan.spanData?.type

    // Identify the first top-level agent span under the root trace.
    if (type === 'agent' && parentId == null) {
      info.currentTopLevelAgentSpanId = oaiSpan.spanId
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

  _updateTraceInfoOutput (oaiSpan) {
    const info = this._traceInfo.get(oaiSpan.traceId)
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

  _resolveParent (oaiSpan) {
    const parentId = oaiSpan.parentId
    const traceId = oaiSpan.traceId
    if (parentId) {
      const parent = this._oaiToDdSpan.get(parentId)
      if (parent) return parent
    }
    if (traceId) {
      const root = this._oaiToDdSpan.get(traceId)
      if (root) return root
    }
  }

  _deriveSpanName (oaiSpan) {
    const spanData = oaiSpan.spanData
    if (spanData?.type === 'handoff') {
      const toAgent = spanData.to_agent || ''
      if (toAgent) return `transfer_to_${toAgent.split(' ').join('_').toLowerCase()}`
    }
    if (spanData?.name) return spanData.name
    return spanData?.type ? `openai_agents.${spanData.type}` : 'openai_agents.request'
  }

  _responseModelName (oaiSpan) {
    const response = oaiSpan.spanData?._response
    if (!response) return
    return response.model || undefined
  }

  // agents-core's `error` is a plain `{ message, data }` object, not a JS
  // Error — there's no constructor to name and no stack. We tag a stable
  // type constant and stringify `data` into the message so the LLMObs error
  // shape stays consistent with other integrations.
  _applyError (ddSpan, oaiSpan) {
    const err = oaiSpan.error
    if (!err) return

    ddSpan.setTag('error', true)

    let errorMessage = err.message || 'Error'
    if (err.data) {
      try {
        errorMessage = JSON.stringify(err.data)
      } catch {
        // circular / non-serializable — fall back to the raw message
      }
    }

    ddSpan.setTag('error.type', AGENTS_ERROR_TYPE)
    ddSpan.setTag('error.message', errorMessage)
    ddSpan.setTag('error.stack', err.stack || '')
  }
}

module.exports = { OpenAIAgentsIntegration }
