'use strict'

const LLMObsPlugin = require('../base')

function safeStringify (value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return '[unserializable]' }
}

class SessionLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_session'
  static prefix = 'tracing:apm:claude-agent-sdk:session'

  getLLMObsSpanRegisterOptions (ctx) {
    const opts = {
      kind: 'agent',
      modelProvider: 'anthropic',
      name: 'claude-agent-sdk.session',
    }
    if (ctx.model) opts.modelName = ctx.model
    return opts
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = ctx.prompt || ''
    this._tagger.tagTextIO(span, input, '')

    const metadata = {}
    if (ctx.sessionId) metadata.session_id = ctx.sessionId
    if (ctx.model) metadata.model = ctx.model
    if (ctx.resume) metadata.parent_session_id = ctx.resume
    if (ctx.permissionMode) metadata.permission_mode = ctx.permissionMode
    if (ctx.maxTurns) metadata.max_turns = ctx.maxTurns
    if (ctx.source) metadata.source = ctx.source
    if (ctx.endReason) metadata.end_reason = ctx.endReason

    this._tagger.tagMetadata(span, metadata)
  }
}

class TurnLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_turn'
  static prefix = 'tracing:apm:claude-agent-sdk:turn'

  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'workflow',
      modelProvider: 'anthropic',
      name: 'claude-agent-sdk.turn',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = ctx.prompt || ''
    const output = ctx.stopReason || ''
    this._tagger.tagTextIO(span, input, output)

    const metadata = {}
    if (ctx.sessionId) metadata.session_id = ctx.sessionId
    if (ctx.stopReason) metadata.stop_reason = ctx.stopReason

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
      name: ctx.toolName || 'claude-agent-sdk.tool',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = safeStringify(ctx.toolInput)
    const output = safeStringify(ctx.toolResponse)

    this._tagger.tagTextIO(span, input, output)

    const metadata = {}
    if (ctx.toolName) metadata.tool_name = ctx.toolName
    if (ctx.toolUseId) metadata.tool_use_id = ctx.toolUseId
    if (ctx.sessionId) metadata.session_id = ctx.sessionId

    this._tagger.tagMetadata(span, metadata)
  }
}

class SubagentLLMObsPlugin extends LLMObsPlugin {
  static integration = 'claude-agent-sdk'
  static id = 'llmobs_claude_agent_sdk_subagent'
  static prefix = 'tracing:apm:claude-agent-sdk:subagent'

  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'agent',
      modelProvider: 'anthropic',
      name: 'claude-agent-sdk.subagent',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const input = ctx.agentType || ctx.agentId || ''
    if (input) this._tagger.tagTextIO(span, input, '')

    const metadata = {}
    if (ctx.agentId) metadata.agent_id = ctx.agentId
    if (ctx.agentType) metadata.agent_type = ctx.agentType
    if (ctx.sessionId) metadata.session_id = ctx.sessionId
    if (ctx.transcriptPath) metadata.transcript_path = ctx.transcriptPath

    this._tagger.tagMetadata(span, metadata)
  }
}

module.exports = [
  SessionLLMObsPlugin,
  TurnLLMObsPlugin,
  ToolLLMObsPlugin,
  SubagentLLMObsPlugin,
]
