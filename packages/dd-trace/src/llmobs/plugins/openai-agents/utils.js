'use strict'

const { getOpenAIModelProvider } = require('../utils')

// Maps JS camelCase modelSettings keys to the snake_case keys used in metadata (Python parity).
const SETTINGS_KEY_MAP = {
  temperature: 'temperature',
  maxTokens: 'max_tokens',
  topP: 'top_p',
  toolChoice: 'tool_choice',
  text: 'text',
  truncation: 'truncation',
}

/**
 * Converts an agent name to a function tool name (Python parity).
 * Replaces all non-alphanumeric characters with underscores.
 *
 * @param {string} name
 * @returns {string}
 */
function toFunctionToolName (name) {
  return name.replaceAll(/[^a-zA-Z0-9]/g, '_')
}

/**
 * Extracts agent manifest metadata from the starting agent (Python parity).
 * Captures name, instructions, model, model_settings, tools, handoffs, and guardrails.
 *
 * @param {object} agent - The Agent instance passed as run()'s first argument
 * @returns {object|null}
 */
function extractAgentManifest (agent) {
  if (!agent) return null

  const manifest = {
    framework: 'openai-agents',
    name: agent.name,
  }

  if (typeof agent.instructions === 'string') {
    manifest.instructions = agent.instructions
  }
  if (agent.handoffDescription) manifest.handoff_description = agent.handoffDescription
  if (agent.model) manifest.model = agent.model

  if (agent.modelSettings) {
    const settings = {}
    for (const [key, value] of Object.entries(agent.modelSettings)) {
      const mappedKey = SETTINGS_KEY_MAP[key]
      if (mappedKey && value !== undefined) {
        settings[mappedKey] = value
      }
    }
    if (Object.keys(settings).length > 0) manifest.model_settings = settings
  }

  if (agent.tools?.length) {
    manifest.tools = agent.tools.map(t => t.name).filter(Boolean)
  }
  if (agent.handoffs?.length) {
    manifest.handoffs = agent.handoffs.map(h => h.agentName ?? h.name).filter(Boolean)
  }
  if (agent.inputGuardrails?.length || agent.outputGuardrails?.length) {
    manifest.guardrails = {
      input: (agent.inputGuardrails ?? []).map(g => g.name).filter(Boolean),
      output: (agent.outputGuardrails ?? []).map(g => g.name).filter(Boolean),
    }
  }

  return manifest
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
 * @param {{ usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number,
 *   outputTokensDetails?: { reasoningTokens?: number } } }} result
 * @returns {{ inputTokens?: number, outputTokens?: number, totalTokens?: number, reasoningTokens?: number }}
 */
function extractMetrics (result) {
  const metrics = {}
  const usage = result?.usage
  if (!usage) return metrics

  const inputTokens = usage.inputTokens ?? usage.input_tokens
  const outputTokens = usage.outputTokens ?? usage.output_tokens
  const totalTokens = usage.totalTokens ?? usage.total_tokens
  const reasoningTokens = usage.outputTokensDetails?.reasoningTokens ??
    usage.output_tokens_details?.reasoning_tokens

  if (inputTokens !== undefined) metrics.inputTokens = inputTokens
  if (outputTokens !== undefined) metrics.outputTokens = outputTokens
  if (reasoningTokens !== undefined) metrics.reasoningTokens = reasoningTokens

  if (totalTokens !== undefined) {
    metrics.totalTokens = totalTokens
  } else if (metrics.inputTokens !== undefined && metrics.outputTokens !== undefined) {
    metrics.totalTokens = metrics.inputTokens + metrics.outputTokens
  }

  return metrics
}

/**
 * Extracts metadata from the model request settings.
 * Keys are mapped to snake_case for Python parity.
 * Includes tools list when present.
 *
 * @param {{ modelSettings?: object, tools?: Array<{ name?: string }> }} request
 * @returns {object}
 */
function extractMetadata (request) {
  const metadata = {}
  const settings = request?.modelSettings

  if (settings) {
    for (const [key, value] of Object.entries(settings)) {
      const mappedKey = SETTINGS_KEY_MAP[key]
      if (mappedKey && value !== undefined) {
        metadata[mappedKey] = value
      }
    }
  }

  if (request?.tools?.length) {
    metadata.tools = request.tools.map(t => t.name || t.type || '').filter(Boolean)
  }

  return metadata
}

module.exports = {
  getOpenAIModelProvider,
  toFunctionToolName,
  extractAgentManifest,
  extractInputMessages,
  extractOutputMessages,
  extractMetrics,
  extractMetadata,
}
