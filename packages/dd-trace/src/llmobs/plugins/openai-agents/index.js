'use strict'

const LLMObsPlugin = require('../base')

// Allowed metadata keys for LLM spans (from ModelSettings)
const ALLOWED_METADATA_KEYS = new Set([
  'max_tokens',
  'max_output_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'reasoning'
])

/**
 * Base class for OpenAI Agents LLMObs plugins
 * Provides common functionality for all OpenAI Agents span types
 */
class BaseOpenAIAgentsLLMObsPlugin extends LLMObsPlugin {
  static integration = 'openai-agents'
}

/**
 * LLMObs plugin for Runner.run() - creates workflow spans
 * This is the top-level span for agent execution
 */
class RunnerRunLLMObsPlugin extends BaseOpenAIAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_runner_run'
  static prefix = 'tracing:@openai/agents:Runner_run'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'workflow',
      name: 'openai-agents.run'
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    // Extract input (the user message/prompt) - second argument to run()
    const input = ctx.arguments?.[1]
    let inputValue = ''
    if (typeof input === 'string') {
      inputValue = input
    } else if (Array.isArray(input)) {
      // Array of messages
      inputValue = input.map(msg => {
        if (typeof msg === 'string') return msg
        if (msg.content) return msg.content
        return JSON.stringify(msg)
      }).join('\n')
    } else if (input) {
      try {
        inputValue = JSON.stringify(input)
      } catch {
        inputValue = String(input)
      }
    }

    // Extract output from result
    let outputValue = ''
    const result = ctx.result
    if (result) {
      // RunResult has finalOutput property
      if (result.finalOutput !== undefined) {
        outputValue = typeof result.finalOutput === 'string'
          ? result.finalOutput
          : JSON.stringify(result.finalOutput)
      } else if (result.output) {
        outputValue = typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output)
      } else if (typeof result === 'string') {
        outputValue = result
      } else {
        try {
          outputValue = JSON.stringify(result)
        } catch {
          outputValue = String(result)
        }
      }
    }

    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

/**
 * LLMObs plugin for model.getResponse() - creates LLM spans
 * This captures non-streaming LLM calls from both OpenAIChatCompletionsModel and OpenAIResponsesModel
 *
 * The ModelRequest format:
 * {
 *   systemInstructions?: string,
 *   input: string | AgentInputItem[],
 *   modelSettings: ModelSettings,
 *   tools: SerializedTool[],
 *   ...
 * }
 *
 * The ModelResponse format:
 * {
 *   usage: Usage,
 *   output: OutputItem[],
 *   responseId: string,
 *   providerData: object
 * }
 */
class GetResponseLLMObsPlugin extends BaseOpenAIAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_get_response'
  static prefix = 'tracing:@openai/agents:OpenAIChatCompletionsModel_getResponse'

  getLLMObsSpanRegisterOptions (ctx) {
    // ModelRequest is the first argument
    const request = ctx.arguments?.[0]
    const modelSettings = request?.modelSettings || {}
    const model = modelSettings.model || ctx.thisArg?.model || 'gpt-4o-mini'

    return {
      kind: 'llm',
      modelName: model,
      modelProvider: 'openai',
      name: 'openai-agents.getResponse'
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    this.#tagLLMIO(ctx)
    this.#tagMetadata(ctx)
    this.#tagMetrics(ctx)
  }

  #tagLLMIO (ctx) {
    const span = ctx.currentStore?.span
    const request = ctx.arguments?.[0] || {}
    const result = ctx.result

    const inputMessages = this.#formatInputMessages(request)
    const outputMessages = this.#formatOutputMessages(result)

    this._tagger.tagLLMIO(span, inputMessages, outputMessages)
  }

  #formatInputMessages (request) {
    const messages = []

    // Add system message from instructions
    if (request.systemInstructions) {
      messages.push({ role: 'system', content: String(request.systemInstructions) })
    }

    // Handle input - can be string or array of AgentInputItem
    const input = request.input
    if (typeof input === 'string') {
      messages.push({ role: 'user', content: input })
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (!item) continue

        // Handle different item types in the input array
        if (item.type === 'message') {
          // Standard message item
          const role = item.role || 'user'
          let content = ''

          if (typeof item.content === 'string') {
            content = item.content
          } else if (Array.isArray(item.content)) {
            content = item.content
              .map(c => {
                if (c.type === 'text' || c.type === 'input_text') return c.text || ''
                if (c.type === 'image' || c.type === 'input_image') return '([IMAGE DETECTED])'
                return ''
              })
              .filter(Boolean)
              .join('')
          } else if (item.content) {
            content = String(item.content)
          }

          messages.push({ role, content })
        } else if (item.type === 'function_call') {
          // Tool call from model - add as assistant message with toolCalls
          let parsedArgs = item.arguments
          if (typeof parsedArgs === 'string') {
            try {
              parsedArgs = JSON.parse(parsedArgs)
            } catch {
              parsedArgs = {}
            }
          }

          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: [{
              toolId: item.call_id || item.id,
              name: item.name,
              arguments: parsedArgs,
              type: 'function'
            }]
          })
        } else if (item.type === 'function_call_output') {
          // Tool result - add as user message with toolResults
          messages.push({
            role: 'user',
            content: '',
            toolResults: [{
              toolId: item.call_id || item.id,
              result: item.output || '',
              type: 'tool_result'
            }]
          })
        } else if (item.role && item.content !== undefined) {
          // Generic message with role and content
          const content = typeof item.content === 'string'
            ? item.content
            : JSON.stringify(item.content)
          messages.push({ role: item.role, content })
        }
      }
    }

    return messages
  }

  #formatOutputMessages (result) {
    if (!result) return []

    const messages = []

    // ModelResponse has output as array of OutputItem
    const output = result.output
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!item) continue

        if (item.type === 'message') {
          // Message output item
          let content = ''
          if (typeof item.content === 'string') {
            content = item.content
          } else if (Array.isArray(item.content)) {
            content = item.content
              .map(c => {
                if (c.type === 'text' || c.type === 'output_text') return c.text || ''
                return ''
              })
              .filter(Boolean)
              .join('')
          }

          messages.push({ role: item.role || 'assistant', content })
        } else if (item.type === 'function_call') {
          // Function call output - add as assistant message with toolCalls
          let parsedArgs = item.arguments
          if (typeof parsedArgs === 'string') {
            try {
              parsedArgs = JSON.parse(parsedArgs)
            } catch {
              parsedArgs = {}
            }
          }

          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: [{
              toolId: item.call_id || item.id,
              name: item.name,
              arguments: parsedArgs,
              type: 'function'
            }]
          })
        } else if (item.type === 'reasoning') {
          // Reasoning output - include as special message
          messages.push({
            role: 'reasoning',
            content: JSON.stringify({
              summary: item.summary || [],
              id: item.id || ''
            })
          })
        } else if (item.content !== undefined) {
          // Fallback for items with content
          const content = typeof item.content === 'string'
            ? item.content
            : JSON.stringify(item.content)
          messages.push({ role: 'assistant', content })
        }
      }
    } else if (typeof output === 'string') {
      // Simple string output
      messages.push({ role: 'assistant', content: output })
    }

    // If no messages extracted, try to get from providerData
    if (messages.length === 0 && result.providerData) {
      const providerOutput = result.providerData.output
      if (Array.isArray(providerOutput)) {
        for (const item of providerOutput) {
          if (item.type === 'message' && item.content) {
            const content = Array.isArray(item.content)
              ? item.content.map(c => c.text || '').join('')
              : item.content
            messages.push({ role: 'assistant', content })
          }
        }
      }
    }

    return messages
  }

  #tagMetadata (ctx) {
    const span = ctx.currentStore?.span
    const request = ctx.arguments?.[0] || {}
    const modelSettings = request.modelSettings || {}

    const metadata = {}
    for (const key of ALLOWED_METADATA_KEYS) {
      if (modelSettings[key] !== undefined) {
        metadata[key] = modelSettings[key]
      }
    }

    if (Object.keys(metadata).length > 0) {
      this._tagger.tagMetadata(span, metadata)
    }
  }

  #tagMetrics (ctx) {
    const span = ctx.currentStore?.span
    const result = ctx.result

    if (!result) return

    // ModelResponse has usage as Usage object
    const usage = result.usage
    if (!usage) return

    const metrics = {}

    // Usage object has inputTokens, outputTokens, totalTokens as properties
    const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0
    const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0

    if (inputTokens !== undefined) metrics.inputTokens = inputTokens
    if (outputTokens !== undefined) metrics.outputTokens = outputTokens

    const totalTokens = usage.totalTokens ?? usage.total_tokens ?? (inputTokens + outputTokens)
    if (totalTokens) metrics.totalTokens = totalTokens

    if (Object.keys(metrics).length > 0) {
      this._tagger.tagMetrics(span, metrics)
    }
  }
}

/**
 * LLMObs plugin for model.getStreamedResponse() - creates LLM spans
 * This captures streaming LLM calls
 */
class GetStreamedResponseLLMObsPlugin extends GetResponseLLMObsPlugin {
  static id = 'llmobs_openai_agents_get_streamed_response'
  static prefix = 'tracing:@openai/agents:OpenAIChatCompletionsModel_getStreamedResponse'

  getLLMObsSpanRegisterOptions (ctx) {
    const request = ctx.arguments?.[0]
    const modelSettings = request?.modelSettings || {}
    const model = modelSettings.model || ctx.thisArg?.model || 'gpt-4o-mini'

    return {
      kind: 'llm',
      modelName: model,
      modelProvider: 'openai',
      name: 'openai-agents.getStreamedResponse'
    }
  }
}

/**
 * LLMObs plugin for tool.invoke() - creates tool spans
 * This captures individual tool executions
 *
 * FunctionTool.invoke(runContext, input, details) where:
 * - runContext is the RunContext
 * - input is a string containing the tool arguments
 * - details is optional { toolCall: FunctionCallItem }
 */
class ToolInvokeLLMObsPlugin extends BaseOpenAIAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_tool_invoke'
  static prefix = 'tracing:@openai/agents:tool_invoke'

  getLLMObsSpanRegisterOptions (ctx) {
    // Tool name from the tool instance (thisArg) which is the FunctionTool object
    const toolName = ctx.thisArg?.name || 'tool'

    return {
      kind: 'tool',
      name: toolName
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    // Extract input - second argument is the input string containing tool arguments
    const input = ctx.arguments?.[1]
    let inputValue = ''
    if (input !== undefined && input !== null) {
      inputValue = typeof input === 'string' ? input : JSON.stringify(input)
    }

    // Extract output (tool result)
    let outputValue = ''
    const result = ctx.result
    if (result !== undefined && result !== null) {
      outputValue = typeof result === 'string' ? result : JSON.stringify(result)
    }

    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

/**
 * LLMObs plugin for executeFunctionToolCalls - creates workflow spans
 * This captures batch tool execution
 */
class ExecuteFunctionToolCallsLLMObsPlugin extends BaseOpenAIAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_execute_function_tool_calls'
  static prefix = 'tracing:@openai/agents:executeFunctionToolCalls'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'workflow',
      name: 'openai-agents.executeFunctionToolCalls'
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    // Input: the tool calls to execute
    const toolCalls = ctx.arguments?.[1]
    let inputValue = ''
    if (toolCalls) {
      try {
        inputValue = JSON.stringify(toolCalls)
      } catch {
        inputValue = String(toolCalls)
      }
    }

    // Output: the results
    let outputValue = ''
    const result = ctx.result
    if (result) {
      try {
        outputValue = JSON.stringify(result)
      } catch {
        outputValue = String(result)
      }
    }

    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

/**
 * LLMObs plugin for executeHandoffCalls - creates workflow spans
 * This captures agent handoff execution
 */
class ExecuteHandoffCallsLLMObsPlugin extends BaseOpenAIAgentsLLMObsPlugin {
  static id = 'llmobs_openai_agents_execute_handoff_calls'
  static prefix = 'tracing:@openai/agents:executeHandoffCalls'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'workflow',
      name: 'openai-agents.executeHandoffCalls'
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    // Input: the handoff calls to execute
    const handoffCalls = ctx.arguments?.[1]
    let inputValue = ''
    if (handoffCalls) {
      try {
        inputValue = JSON.stringify(handoffCalls)
      } catch {
        inputValue = String(handoffCalls)
      }
    }

    // Output: the results
    let outputValue = ''
    const result = ctx.result
    if (result) {
      try {
        outputValue = JSON.stringify(result)
      } catch {
        outputValue = String(result)
      }
    }

    this._tagger.tagTextIO(span, inputValue, outputValue)
  }
}

module.exports = {
  RunnerRunLLMObsPlugin,
  GetResponseLLMObsPlugin,
  GetStreamedResponseLLMObsPlugin,
  ToolInvokeLLMObsPlugin,
  ExecuteFunctionToolCallsLLMObsPlugin,
  ExecuteHandoffCallsLLMObsPlugin
}
