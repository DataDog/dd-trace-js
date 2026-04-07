'use strict'

const LLMObsPlugin = require('../base')
const {
  getModelProvider,
  toFunctionToolName,
  extractAgentManifest,
  extractInputMessages,
  extractOutputMessages,
  extractMetrics,
  extractMetadata,
} = require('./utils')

// ── Orchestration plugins (workflow / agent / tool / task span kinds) ─────────

/**
 * LLMObs plugin for the top-level `run()` orchestration entry point.
 * Emits a `workflow` span capturing the agent name, input query, and final output.
 */
class RunLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_openai_agents_run'
  static integration = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:run'

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown> }} ctx
   * @returns {{ kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const workflowName = ctx.arguments?.[2]?.workflowName ?? 'Agent workflow'
    return {
      kind: 'workflow',
      name: workflowName,
    }
  }

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown>, result?: object }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const agent = ctx.arguments?.[0]
    const manifest = extractAgentManifest(agent)
    if (manifest) {
      this._tagger.tagMetadata(span, { _dd: { agent_manifest: manifest } })
    }

    const input = ctx.arguments?.[1]
    const inputValue = input === undefined ? '' : String(input)

    const error = !!span.context()._tags.error
    if (error) {
      this._tagger.tagTextIO(span, inputValue, '')
      return
    }

    const outputValue = ctx.result?.finalOutput === undefined ? '' : String(ctx.result.finalOutput)
    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

/**
 * LLMObs plugin for individual tool / function invocations.
 * Emits a `tool` span capturing the tool name, serialized arguments, and result.
 */
class InvokeFunctionToolLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_openai_agents_invoke_function_tool'
  static integration = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:invokeFunctionTool'

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown> }} ctx
   * @returns {{ kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'tool',
      name: 'openai-agents.invokeFunctionTool',
    }
  }

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown>, result?: unknown }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const toolName = params?.tool?.name
    if (toolName) span.setTag('tool.name', toolName)

    const inputValue = params?.input === undefined ? '' : String(params.input)

    const error = !!span.context()._tags.error
    if (error) {
      this._tagger.tagTextIO(span, inputValue, '')
      return
    }

    const outputValue = ctx.result === undefined ? '' : String(ctx.result)
    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

/**
 * LLMObs plugin for agent-to-agent handoff operations.
 * Emits an `agent` span named `transfer_to_{agentName}` (Python parity).
 */
class OnInvokeHandoffLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_openai_agents_on_invoke_handoff'
  static integration = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:onInvokeHandoff'

  /**
   * @param {{ currentStore?: { span: object }, self?: { agentName?: string }, arguments?: Array<unknown> }} ctx
   * @returns {{ kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const agentName = ctx.self?.agentName
    const spanName = agentName
      ? `transfer_to_${toFunctionToolName(agentName)}`
      : 'openai-agents.onInvokeHandoff'
    return {
      kind: 'agent',
      name: spanName,
    }
  }

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown>, result?: unknown }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = ctx.arguments?.[1]
    const inputValue = input === undefined ? '' : String(input)

    const error = !!span.context()._tags.error
    if (error) {
      this._tagger.tagTextIO(span, inputValue, '')
      return
    }

    const outputValue = ctx.result === undefined ? '' : String(ctx.result)
    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

/**
 * LLMObs plugin for tool-input guardrail validation.
 * Emits a `task` span capturing the tool call and guardrail result.
 */
class RunToolInputGuardrailsLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_openai_agents_run_tool_input_guardrails'
  static integration = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:runToolInputGuardrails'

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown> }} ctx
   * @returns {{ kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'task',
      name: 'openai-agents.runInputGuardrails',
    }
  }

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown>, result?: unknown }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const inputValue = params?.toolCall === undefined ? '' : JSON.stringify(params.toolCall)

    const error = !!span.context()._tags.error
    if (error) {
      this._tagger.tagTextIO(span, inputValue, '')
      return
    }

    const outputValue = ctx.result === undefined ? '' : JSON.stringify(ctx.result)
    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

/**
 * LLMObs plugin for tool-output guardrail validation.
 * Emits a `task` span capturing the tool output and guardrail result.
 */
class RunToolOutputGuardrailsLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_openai_agents_run_tool_output_guardrails'
  static integration = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:runToolOutputGuardrails'

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown> }} ctx
   * @returns {{ kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'task',
      name: 'openai-agents.runOutputGuardrails',
    }
  }

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown>, result?: unknown }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const inputValue = params?.toolCall === undefined
      ? ''
      : JSON.stringify({ toolCall: params.toolCall, toolOutput: params.toolOutput })

    const error = !!span.context()._tags.error
    if (error) {
      this._tagger.tagTextIO(span, inputValue, '')
      return
    }

    const outputValue = ctx.result === undefined ? '' : JSON.stringify(ctx.result)
    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

// ── LLM plugins (llm span kind, model layer) ──────────────────────────────────

/**
 * Base LLMObs plugin for OpenAI Agents model operations (getResponse, getStreamedResponse).
 * Instruments the \@openai/agents-openai model classes to capture LLM span events.
 */
class BaseOpenaiAgentsLLMObsPlugin extends LLMObsPlugin {
  static integration = 'openai-agents'

  /**
   * Returns span registration options for the LLMObs span.
   * Span name follows Python parity: `{modelName} (LLM)` when model name is known.
   *
   * @param {{ self?: { _model?: string, _client?: { baseURL?: string } } }} ctx - Orchestrion context
   * @returns {{ modelProvider: string, modelName: string, kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const modelName = ctx.self?._model || ''
    const baseURL = ctx.self?._client?.baseURL || ''
    const modelProvider = getModelProvider(baseURL)

    return {
      modelProvider,
      modelName,
      kind: 'llm',
      name: modelName ? `${modelName} (LLM)` : 'openai-agents.llm',
    }
  }

  /**
   * Extracts and tags LLM-specific data on the span after the operation completes.
   *
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown>, result?: object }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const request = ctx.arguments?.[0]
    const error = !!span.context()._tags.error

    const inputMessages = extractInputMessages(request)

    if (error) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '', role: '' }])
      return
    }

    const outputMessages = extractOutputMessages(ctx.result)
    this._tagger.tagLLMIO(span, inputMessages, outputMessages)

    const metrics = extractMetrics(ctx.result)
    this._tagger.tagMetrics(span, metrics)

    const metadata = extractMetadata(request)
    if (Object.keys(metadata).length > 0) {
      this._tagger.tagMetadata(span, metadata)
    }
  }
}

class GetResponseLLMObsPlugin extends BaseOpenaiAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_get_response'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getResponse'
}

class GetStreamedResponseLLMObsPlugin extends BaseOpenaiAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_get_streamed_response'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getStreamedResponse'

  /**
   * Tags inputs and metadata on the streaming span.
   * Streamed output cannot be captured here because the span closes when the AsyncIterator
   * is returned — before the caller iterates it. Collecting output would require the
   * tracing plugin to hold the span open until the iterator is exhausted, which is a
   * separate, larger change.
   * TODO: wrap the AsyncIterator to accumulate output and finish the span on completion.
   *
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown> }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const request = ctx.arguments?.[0]
    const inputMessages = extractInputMessages(request)

    this._tagger.tagLLMIO(span, inputMessages, [{ content: '', role: '' }])

    const metadata = extractMetadata(request)
    metadata.stream = true
    this._tagger.tagMetadata(span, metadata)
  }
}

module.exports = [
  RunLLMObsPlugin,
  InvokeFunctionToolLLMObsPlugin,
  OnInvokeHandoffLLMObsPlugin,
  RunToolInputGuardrailsLLMObsPlugin,
  RunToolOutputGuardrailsLLMObsPlugin,
  GetResponseLLMObsPlugin,
  GetStreamedResponseLLMObsPlugin,
]
