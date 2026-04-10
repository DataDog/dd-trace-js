'use strict'

const LLMObsPlugin = require('../base')

const SOURCE_TO_TRIGGER = {
  startup: 'fresh',
  resume: 'resume',
  clear: 'context_clear',
  compact: 'compaction',
}

function safeStringify (value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return '[unserializable]' }
}

function splitModel (model) {
  if (!model) return { modelName: undefined, modelProvider: 'anthropic' }
  const idx = model.indexOf('/')
  if (idx === -1) return { modelName: model, modelProvider: 'anthropic' }
  return { modelName: model.slice(idx + 1), modelProvider: model.slice(0, idx) }
}

class SessionLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_session'
  static prefix = 'tracing:apm:claude-agent-sdk:session'

  getLLMObsSpanRegisterOptions (ctx) {
    const { modelName, modelProvider } = splitModel(ctx.model)
    return {
      kind: 'agent',
      modelName,
      modelProvider,
      name: 'session',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = ctx.prompt || ''
    const output = ctx.lastAssistantMessage || ctx.endReason || ''
    this._tagger.tagTextIO(span, input, output)

    const metadata = {}
    if (ctx.sessionId) metadata.session_id = ctx.sessionId
    if (ctx.model) {
      const { modelName, modelProvider } = splitModel(ctx.model)
      if (modelName) metadata.model_name = modelName
      if (modelProvider) metadata.model_provider = modelProvider
    }
    if (ctx.source) metadata.start_trigger = SOURCE_TO_TRIGGER[ctx.source] || ctx.source
    if (ctx.permissionMode) metadata.permission_mode = ctx.permissionMode
    if (ctx.cwd) metadata.project_dir = ctx.cwd
    if (ctx.agentType) metadata.agent_type = ctx.agentType
    if (ctx.endReason) metadata.exit_reason = ctx.endReason
    if (ctx.transcriptPath) metadata.transcript_path = ctx.transcriptPath

    this._tagger.tagMetadata(span, metadata)
  }
}

class TurnLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_turn'
  static prefix = 'tracing:apm:claude-agent-sdk:turn'

  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'agent',
      modelProvider: 'anthropic',
      name: 'turn',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = ctx.prompt || ''
    const output = ctx.lastAssistantMessage || ctx.stopReason || ''
    this._tagger.tagTextIO(span, input, output)

    const metadata = {}
    if (ctx.sessionId) metadata.session_id = ctx.sessionId

    this._tagger.tagMetadata(span, metadata)
  }
}

class ToolLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_tool'
  static prefix = 'tracing:apm:claude-agent-sdk:tool'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'tool',
      modelProvider: 'anthropic',
      name: ctx.toolName || 'tool',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = safeStringify(ctx.toolInput)
    const output = ctx.error
      ? safeStringify(ctx.error)
      : safeStringify(ctx.toolResponse)

    this._tagger.tagTextIO(span, input, output)

    const metadata = {}
    if (ctx.toolName) metadata.tool_name = ctx.toolName
    if (ctx.toolUseId) metadata.tool_use_id = ctx.toolUseId
    if (ctx.sessionId) metadata.session_id = ctx.sessionId
    if (ctx.isInterrupt) metadata.is_interrupt = true

    this._tagger.tagMetadata(span, metadata)
  }
}

class SubagentLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_subagent'
  static prefix = 'tracing:apm:claude-agent-sdk:subagent'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'agent',
      modelProvider: 'anthropic',
      name: ctx.agentType ? `subagent-${ctx.agentType}` : 'subagent',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = ctx.agentType || ctx.agentId || ''
    const output = ctx.lastAssistantMessage || ''
    this._tagger.tagTextIO(span, input, output)

    const metadata = {}
    if (ctx.agentId) metadata.agent_id = ctx.agentId
    if (ctx.agentType) metadata.agent_type = ctx.agentType
    if (ctx.sessionId) metadata.session_id = ctx.sessionId
    if (ctx.transcriptPath) metadata.agent_transcript_path = ctx.transcriptPath

    this._tagger.tagMetadata(span, metadata)
  }
}

module.exports = [
  SessionLLMObsPlugin,
  TurnLLMObsPlugin,
  ToolLLMObsPlugin,
  SubagentLLMObsPlugin,
]
