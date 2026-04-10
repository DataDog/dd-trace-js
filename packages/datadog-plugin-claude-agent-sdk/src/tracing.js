'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const SOURCE_TO_TRIGGER = {
  startup: 'fresh',
  resume: 'resume',
  clear: 'context_clear',
  compact: 'compaction',
}

class BaseClaudeAgentSdkTracingPlugin extends TracingPlugin {
  static system = 'claude-agent-sdk'

  bindStart (ctx) {
    const spanName = this.constructor.computeSpanName(ctx)
    const tags = this.constructor.extractTags(ctx)

    this.startSpan(spanName, {
      meta: {
        'resource.name': ctx.resource || spanName,
        ...tags,
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }

  static computeSpanName () {
    return 'claude-agent-sdk'
  }

  static extractTags () {
    return null
  }
}

class SessionTracingPlugin extends BaseClaudeAgentSdkTracingPlugin {
  static id = 'claude_agent_sdk_session'
  static operation = 'session'
  static prefix = 'tracing:apm:claude-agent-sdk:session'

  static computeSpanName () {
    return 'session'
  }

  static extractTags (ctx) {
    const tags = {}
    if (ctx.sessionId) tags['claude-agent-sdk.session.id'] = ctx.sessionId
    if (ctx.model) tags['claude-agent-sdk.session.model'] = ctx.model
    if (ctx.resume) tags['claude-agent-sdk.session.parent_session_id'] = ctx.resume
    if (ctx.permissionMode) tags['claude-agent-sdk.session.permission_mode'] = ctx.permissionMode
    if (ctx.cwd) tags['claude-agent-sdk.session.project_dir'] = ctx.cwd
    if (ctx.source) tags['claude-agent-sdk.session.start_trigger'] = SOURCE_TO_TRIGGER[ctx.source] || ctx.source
    if (ctx.agentType) tags['claude-agent-sdk.session.agent_type'] = ctx.agentType
    return tags
  }
}

class TurnTracingPlugin extends BaseClaudeAgentSdkTracingPlugin {
  static id = 'claude_agent_sdk_turn'
  static operation = 'turn'
  static prefix = 'tracing:apm:claude-agent-sdk:turn'

  static computeSpanName () {
    return 'turn'
  }

  static extractTags (ctx) {
    const tags = {}
    if (ctx.sessionId) tags['claude-agent-sdk.session.id'] = ctx.sessionId
    return tags
  }
}

class ToolTracingPlugin extends BaseClaudeAgentSdkTracingPlugin {
  static id = 'claude_agent_sdk_tool'
  static operation = 'tool'
  static prefix = 'tracing:apm:claude-agent-sdk:tool'

  static computeSpanName (ctx) {
    return ctx.toolName || 'tool'
  }

  static extractTags (ctx) {
    const tags = {}
    if (ctx.toolName) tags['claude-agent-sdk.tool.name'] = ctx.toolName
    if (ctx.toolUseId) tags['claude-agent-sdk.tool.use_id'] = ctx.toolUseId
    if (ctx.sessionId) tags['claude-agent-sdk.session.id'] = ctx.sessionId
    return tags
  }
}

class SubagentTracingPlugin extends BaseClaudeAgentSdkTracingPlugin {
  static id = 'claude_agent_sdk_subagent'
  static operation = 'subagent'
  static prefix = 'tracing:apm:claude-agent-sdk:subagent'

  static computeSpanName (ctx) {
    return ctx.agentType ? `subagent-${ctx.agentType}` : 'subagent'
  }

  static extractTags (ctx) {
    const tags = {}
    if (ctx.agentId) tags['claude-agent-sdk.subagent.id'] = ctx.agentId
    if (ctx.agentType) tags['claude-agent-sdk.subagent.type'] = ctx.agentType
    if (ctx.sessionId) tags['claude-agent-sdk.session.id'] = ctx.sessionId
    return tags
  }
}

module.exports = [
  SessionTracingPlugin,
  TurnTracingPlugin,
  ToolTracingPlugin,
  SubagentTracingPlugin,
]
