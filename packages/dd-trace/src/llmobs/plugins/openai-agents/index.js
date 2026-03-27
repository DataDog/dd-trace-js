'use strict'

const LLMObsPlugin = require('../base')

const ALLOWED_SETTINGS_KEYS = new Set([
  'temperature',
  'maxTokens',
  'topP',
  'stream',
])

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
    return {
      kind: 'workflow',
      name: 'openai-agents.run',
    }
  }

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown>, result?: object }} ctx
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
  getLLMObsSpanRegisterOptions (ctx) {
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
 * Emits an `agent` span capturing the handoff input and result.
 */
class OnInvokeHandoffLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_openai_agents_on_invoke_handoff'
  static integration = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:onInvokeHandoff'

  /**
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown> }} ctx
   * @returns {{ kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'agent',
      name: 'openai-agents.onInvokeHandoff',
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
  getLLMObsSpanRegisterOptions (ctx) {
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
  getLLMObsSpanRegisterOptions (ctx) {
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
      name: `openai-agents.${this.constructor.operation}`,
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
  static operation = 'getResponse'
}

class GetStreamedResponseLLMObsPlugin extends BaseOpenaiAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_get_streamed_response'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getStreamedResponse'
  static operation = 'getStreamedResponse'

  /**
   * For streaming, the span finishes before stream iteration begins.
   * Output data is not available, so we only tag inputs and metadata.
   *
   * @param {{ currentStore?: { span: object }, arguments?: Array<unknown> }} ctx
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const request = ctx.arguments?.[0]
    const inputMessages = extractInputMessages(request)

    // Streaming spans finish before iteration; output is not available
    this._tagger.tagLLMIO(span, inputMessages, [{ content: '', role: '' }])

    const metadata = extractMetadata(request)
    metadata.stream = true
    this._tagger.tagMetadata(span, metadata)
  }
}

/**
 * Determines the model provider from the OpenAI client base URL.
 *
 * @param {string} baseURL - The base URL of the OpenAI client
 * @returns {string} The model provider name
 */
function getModelProvider (baseURL) {
  if (baseURL.includes('azure')) return 'azure_openai'
  if (baseURL.includes('deepseek')) return 'deepseek'
  return 'openai'
}

/**
 * Extracts input messages from the model request object.
 *
 * @param {{ systemInstructions?: string, input?: string|Array<unknown> }} request
 * @returns {Array<{ role: string, content: string }>}
 */
function extractInputMessages (request) {
  const messages = []

  if (request?.systemInstructions) {
    messages.push({ role: 'system', content: request.systemInstructions })
  }

  const input = request?.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item.type === 'message') {
        const role = item.role
        if (!role) continue

        let content = ''
        if (Array.isArray(item.content)) {
          const textParts = item.content
            .filter(c => c.type === 'input_text' || c.type === 'text')
            .map(c => c.text)
          content = textParts.join('')
        } else if (typeof item.content === 'string') {
          content = item.content
        }

        if (content) {
          messages.push({ role, content })
        }
      } else if (item.type === 'function_call') {
        let args = item.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            args = {}
          }
        }
        messages.push({
          role: 'assistant',
          toolCalls: [{
            toolId: item.call_id,
            name: item.name,
            arguments: args,
            type: item.type,
          }],
        })
      } else if (item.type === 'function_call_output') {
        messages.push({
          role: 'user',
          toolResults: [{
            toolId: item.call_id,
            result: item.output,
            name: item.name || '',
            type: item.type,
          }],
        })
      } else if (item.role && item.content) {
        messages.push({
          role: item.role,
          content: typeof item.content === 'string' ? item.content : '',
        })
      }
    }
  }

  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

/**
 * Extracts output messages from the model response.
 *
 * @param {{ output?: Array<unknown> }} result - The model response
 * @returns {Array<{ role: string, content: string }>}
 */
function extractOutputMessages (result) {
  if (!result?.output) return [{ content: '', role: '' }]

  const messages = []

  for (const item of result.output) {
    if (item.type === 'message') {
      let content = ''
      if (Array.isArray(item.content)) {
        const textParts = item.content
          .filter(c => c.type === 'output_text')
          .map(c => c.text)
        content = textParts.join('')
      } else if (typeof item.content === 'string') {
        content = item.content
      }

      messages.push({ role: item.role || 'assistant', content })
    } else if (item.type === 'function_call') {
      let args = item.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = {}
        }
      }
      messages.push({
        role: 'assistant',
        toolCalls: [{
          toolId: item.call_id,
          name: item.name,
          arguments: args,
          type: item.type,
        }],
      })
    }
  }

  return messages.length > 0 ? messages : [{ content: '', role: '' }]
}

/**
 * Extracts token usage metrics from the model response.
 *
 * @param {{ usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number } }} result
 * @returns {{ inputTokens?: number, outputTokens?: number, totalTokens?: number }}
 */
function extractMetrics (result) {
  const metrics = {}
  const usage = result?.usage
  if (!usage) return metrics

  const inputTokens = usage.inputTokens ?? usage.input_tokens
  const outputTokens = usage.outputTokens ?? usage.output_tokens
  const totalTokens = usage.totalTokens ?? usage.total_tokens

  if (inputTokens !== undefined) metrics.inputTokens = inputTokens
  if (outputTokens !== undefined) metrics.outputTokens = outputTokens

  if (totalTokens !== undefined) {
    metrics.totalTokens = totalTokens
  } else if (metrics.inputTokens !== undefined && metrics.outputTokens !== undefined) {
    metrics.totalTokens = metrics.inputTokens + metrics.outputTokens
  }

  return metrics
}

/**
 * Extracts metadata from the model request settings.
 *
 * @param {{ modelSettings?: object }} request
 * @returns {object}
 */
function extractMetadata (request) {
  const metadata = {}
  const settings = request?.modelSettings
  if (!settings) return metadata

  for (const [key, value] of Object.entries(settings)) {
    if (ALLOWED_SETTINGS_KEYS.has(key) && value !== undefined) {
      metadata[key] = value
    }
  }

  return metadata
}

module.exports = {
  RunLLMObsPlugin,
  InvokeFunctionToolLLMObsPlugin,
  OnInvokeHandoffLLMObsPlugin,
  RunToolInputGuardrailsLLMObsPlugin,
  RunToolOutputGuardrailsLLMObsPlugin,
  GetResponseLLMObsPlugin,
  GetStreamedResponseLLMObsPlugin,
}
