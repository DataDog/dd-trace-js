'use strict'

const LLMObsPlugin = require('../base')
const { storage: llmobsStorage } = require('../../storage')
const { NAME, SESSION_ID } = require('../../constants/tags')
const { splitModel } = require('../../../../../datadog-plugin-claude-agent-sdk/src/util')

const subagentToolIds = new Set()

function normalizeToolOutputString (raw) {
  const footerIndex = raw.search(/\r?\n+\s*agentId: /)
  if (footerIndex === -1) return raw

  return raw.slice(0, footerIndex).trimEnd()
}

function getToolOutputText (raw) {
  if (raw == null) return

  if (Array.isArray(raw)) {
    const output = []
    for (const block of raw) {
      const text = getToolOutputText(block)
      if (text) output.push(text)
    }
    return output.join('\n') || undefined
  }

  if (raw.type === 'tool_result') return getToolOutputText(raw.content)
  if (raw.type === 'text') return normalizeToolOutputString(raw.text)
  if (raw.type === 'tool_reference') return raw.tool_name
  if (raw.content !== undefined) return getToolOutputText(raw.content)

  if (typeof raw === 'string') return normalizeToolOutputString(raw)

  return JSON.stringify(raw)
}

function buildOutputMessages (chunks, llmStartIdx, llmEndIdx) {
  let thinking = ''
  let text = ''
  const toolCalls = []

  for (let i = llmStartIdx; i < llmEndIdx; i++) {
    const c = chunks[i]
    if (c.type !== 'assistant') continue
    const block = c.message?.content?.[0]
    if (block?.type === 'thinking') thinking += block.thinking ?? ''
    else if (block?.type === 'text') text += block.text ?? ''
    else if (block?.type === 'tool_use') {
      toolCalls.push({ name: block.name, arguments: block.input ?? {}, toolId: block.id, type: block.type })
    }
  }

  const messages = []
  if (thinking) messages.push({ role: 'thinking', content: thinking })
  const msg = { role: 'assistant', content: text }
  if (toolCalls.length) msg.toolCalls = toolCalls
  messages.push(msg)
  return messages
}

class QueryLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_query'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query'

  getLLMObsSpanRegisterOptions (ctx) {
    return { kind: 'agent' }
  }

  start (ctx) {
    super.start(ctx)
    if (!this._tracerConfig.llmobs.DD_LLMOBS_ENABLED) return
    const store = llmobsStorage.getStore()
    const prev = ctx.runInContext ?? (fn => fn())
    ctx.runInContext = fn => prev(() => llmobsStorage.run(store, fn))
  }

  asyncEnd (ctx) {
    if (!ctx.streamResolved) return
    super.asyncEnd(ctx)
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    // post-populate session_id
    if (ctx.session_id) this._tagger._setTag(span, SESSION_ID, ctx.session_id)
    this._tagger.tagTextIO(span, ctx.arguments?.[0]?.prompt, ctx.output)

    // metadata
    const { cwd, permissionMode } = ctx
    const metadata = {}

    if (cwd) metadata.cwd = cwd
    if (permissionMode) metadata.permissionMode = permissionMode

    this._tagger.tagMetadata(span, metadata)
  }
}

class StepLlmObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'claude_agent_sdk_step_llmobs'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:step'

  getLLMObsSpanRegisterOptions (ctx) {
    if (ctx.parentToolUseId) subagentToolIds.add(ctx.parentToolUseId)
    return { kind: 'step', name: `step-${ctx.stepIndex}`, sessionId: ctx.sessionId }
  }

  end (ctx) {
    super.end(ctx)
    super.asyncEnd(ctx)
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { chunks, llmStartIdx, llmEndIdx, toolOutputs } = ctx
    if (!chunks) return

    const outputMessages = buildOutputMessages(chunks, llmStartIdx, llmEndIdx)
    const thinking = outputMessages.find(m => m.role === 'thinking')?.content ?? ''

    const output = toolOutputs?.length
      ? getToolOutputText(toolOutputs)
      : outputMessages.find(m => m.role === 'assistant')?.content ?? ''

    this._tagger.tagTextIO(span, thinking, output)
  }
}

class LlmLlmObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'claude_agent_sdk_llm_llmobs'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:llm'

  getLLMObsSpanRegisterOptions (ctx) {
    const { modelName, modelProvider } = splitModel(ctx.model)
    return { kind: 'llm', name: ctx.model, modelName, modelProvider, sessionId: ctx.sessionId }
  }

  end (ctx) {
    super.end(ctx)
    super.asyncEnd(ctx)
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { chunks, llmStartIdx, llmEndIdx, parentToolUseId, initialPrompt, usage } = ctx

    if (chunks) {
      const inputMessages = this.#buildInputMessages(chunks, llmStartIdx, parentToolUseId, initialPrompt)
      const outputMessages = buildOutputMessages(chunks, llmStartIdx, llmEndIdx)
      this._tagger.tagLLMIO(span, inputMessages, outputMessages)
    }

    if (usage) {
      const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0
      const inputTokens = (usage.input_tokens ?? 0) + cacheWriteTokens + cacheReadTokens
      const outputTokens = usage.output_tokens ?? 0
      this._tagger.tagMetrics(span, {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_write_input_tokens: cacheWriteTokens,
        total_tokens: inputTokens + outputTokens,
      })
    }
  }

  #buildInputMessages (chunks, llmStartIdx, parentToolUseId, initialPrompt) {
    const messages = []
    if (initialPrompt) messages.push({ role: 'user', content: initialPrompt })
    const seenIds = new Set()

    for (let i = 0; i < llmStartIdx; i++) {
      const c = chunks[i]
      if (c.parent_tool_use_id !== parentToolUseId) continue

      if (c.type === 'assistant') {
        const msgId = c.message?.id
        if (!msgId || seenIds.has(msgId)) continue
        seenIds.add(msgId)

        let thinking = ''
        let text = ''
        const toolCalls = []
        for (let j = i; j < llmStartIdx; j++) {
          const cc = chunks[j]
          if (cc.type !== 'assistant' || cc.message?.id !== msgId) break
          const block = cc.message?.content?.[0]
          if (block?.type === 'thinking') thinking += block.thinking ?? ''
          else if (block?.type === 'text') text += block.text ?? ''
          else if (block?.type === 'tool_use') {
            toolCalls.push({ name: block.name, arguments: block.input ?? {}, toolId: block.id, type: block.type })
          }
        }
        if (thinking) messages.push({ role: 'thinking', content: thinking })
        const msg = { role: 'assistant', content: text }
        if (toolCalls.length) msg.toolCalls = toolCalls
        messages.push(msg)
      } else if (c.type === 'user') {
        const content = c.message?.content
        if (!content) continue
        for (const block of content) {
          if (block.type === 'text') {
            messages.push({ role: 'user', content: block.text ?? '' })
          } else if (block.type === 'tool_result') {
            const text = getToolOutputText(block.content) ?? ''
            messages.push({ role: 'tool', content: text })
          }
        }
      }
    }

    return messages
  }
}

class ToolLlmObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'claude_agent_sdk_tool_llmobs'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:tool'

  getLLMObsSpanRegisterOptions (ctx) {
    return { kind: 'tool', name: ctx.name, sessionId: ctx.sessionId }
  }

  end (ctx) {
    super.end(ctx)
    super.asyncEnd(ctx)
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    if (subagentToolIds.has(ctx.id)) {
      subagentToolIds.delete(ctx.id)
      const description = ctx.input?.description
      this._tagger.changeKind(span, 'agent')
      if (description) this._tagger._setTag(span, NAME, `${ctx.name} (${description})`)
      const output = getToolOutputText(ctx.output)
      this._tagger.tagTextIO(span, ctx.input?.prompt, output)
      return
    }

    const input = ctx.input ? JSON.stringify(ctx.input) : undefined
    const output = getToolOutputText(ctx.output)
    this._tagger.tagTextIO(span, input, output)
  }
}

module.exports = [
  QueryLLMObsPlugin,
  StepLlmObsPlugin,
  ToolLlmObsPlugin,
  LlmLlmObsPlugin,
]
