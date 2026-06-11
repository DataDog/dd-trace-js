'use strict'

const { tracingChannel } = require('dc-polyfill')
const { storage } = require('../../datadog-core/')
const { addHook, getHooks } = require('./helpers/instrument')
const queryChannel = tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query')

const turnCh = tracingChannel('apm:claude-agent-sdk:turn')
const toolCh = tracingChannel('apm:claude-agent-sdk:tool')
const subagentCh = tracingChannel('apm:claude-agent-sdk:subagent')

const mergeHooks = function mergeHooks (userHooks, tracerHooks) {
  const merged = {}

  for (const event of Object.keys(tracerHooks)) {
    const userMatchers = (userHooks && userHooks[event]) || []
    const tracerMatchers = tracerHooks[event]
    merged[event] = [...userMatchers, ...tracerMatchers]
  }

  // Preserve any user hooks for events we don't trace
  if (userHooks) {
    for (const event of Object.keys(userHooks)) {
      if (!merged[event]) {
        merged[event] = userHooks[event]
      }
    }
  }

  return merged
}

function buildTracerHooks (sessionCtx) {
  const onSessionStart = function (input) {
    sessionCtx.sessionId = input.session_id
    sessionCtx.source = input.source
    sessionCtx.cwd = input.cwd
    sessionCtx.transcriptPath = input.transcript_path
    sessionCtx.agentType = input.agent_type
    sessionCtx.permissionMode = sessionCtx.permissionMode || input.permission_mode
    return {}
  }

  const onSessionEnd = function (input) {
    sessionCtx.endReason = input.reason
    finishSession(sessionCtx)
    return {}
  }

  const onUserPromptSubmit = function (input) {
    if (!sessionCtx.sessionId && input.session_id) {
      sessionCtx.sessionId = input.session_id
    }

    const turnCtx = {
      sessionId: input.session_id,
      prompt: input.prompt,
      // Propagate session-level metadata so turn spans carry it
      model: sessionCtx.model,
      source: sessionCtx.source,
      cwd: sessionCtx.cwd,
      agentType: sessionCtx.agentType,
      permissionMode: sessionCtx.permissionMode,
      transcriptPath: sessionCtx.transcriptPath,
    }

    sessionCtx.currentTurn = turnCtx
    turnCh.start.runStores(turnCtx, () => {})
    return {}
  }

  const onStop = function (input) {
    const turnCtx = sessionCtx.currentTurn
    if (turnCtx) {
      turnCtx.stopReason = input.stop_reason
      turnCtx.lastAssistantMessage = input.last_assistant_message
      turnCh.end.publish(turnCtx)
      turnCh.asyncEnd.publish(turnCtx)
      sessionCtx.currentTurn = null
    }
    sessionCtx.lastAssistantMessage = input.last_assistant_message
    return {}
  }

  const onPreToolUse = function (input, toolUseId) {
    const id = toolUseId || input.tool_use_id
    if (!id) return {}

    const isSubAgentTool = input.tool_input?.subagent_type
    if (isSubAgentTool != null) return {} // do not trace tools as subagents, we trace the actual subagent instead

    const toolCtx = {
      sessionId: input.session_id,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: id,
    }

    sessionCtx.pendingTools.set(id, toolCtx)

    const turnStore = sessionCtx.currentTurn?.currentStore
    if (turnStore) {
      storage('legacy').run(turnStore, () => toolCh.start.runStores(toolCtx, () => {}))
    } else {
      toolCh.start.runStores(toolCtx, () => {})
    }

    return {}
  }

  const onPostToolUse = function (input, toolUseId) {
    const isSubAgentTool = input.tool_input?.subagent_type
    if (isSubAgentTool != null) return {}

    const id = toolUseId || input.tool_use_id
    const toolCtx = sessionCtx.pendingTools.get(id)
    if (toolCtx) {
      toolCtx.toolResponse = input.tool_response
      toolCtx.toolName = toolCtx.toolName || input.tool_name
      sessionCtx.pendingTools.delete(id)
      toolCh.end.publish(toolCtx)
      toolCh.asyncEnd.publish(toolCtx)
    }
    return {}
  }

  const onPostToolUseFailure = function (input, toolUseId) {
    const isSubAgentTool = input.tool_input?.subagent_type
    if (isSubAgentTool != null) return {}

    const id = toolUseId || input.tool_use_id
    const toolCtx = sessionCtx.pendingTools.get(id)
    if (toolCtx) {
      toolCtx.error = input.error
      toolCtx.isInterrupt = input.is_interrupt
      sessionCtx.pendingTools.delete(id)
      toolCh.error.publish(toolCtx)
      toolCh.asyncEnd.publish(toolCtx)
    }
    return {}
  }

  const onSubagentStart = function (input) {
    const agentId = input.agent_id
    if (!agentId) return {}

    const subagentCtx = {
      sessionId: input.session_id,
      agentId,
      agentType: input.agent_type,
    }

    sessionCtx.pendingSubagents.set(agentId, subagentCtx)

    const turnStore = sessionCtx.currentTurn?.currentStore
    if (turnStore) {
      storage('legacy').run(turnStore, () => subagentCh.start.runStores(subagentCtx, () => {}))
    } else {
      subagentCh.start.runStores(subagentCtx, () => {})
    }

    return {}
  }

  const onSubagentStop = function (input) {
    const agentId = input.agent_id
    const subagentCtx = sessionCtx.pendingSubagents.get(agentId)
    if (subagentCtx) {
      subagentCtx.transcriptPath = input.agent_transcript_path
      subagentCtx.lastAssistantMessage = input.last_assistant_message
      subagentCtx.agentType = subagentCtx.agentType || input.agent_type
      sessionCtx.pendingSubagents.delete(agentId)
      subagentCh.end.publish(subagentCtx)
      subagentCh.asyncEnd.publish(subagentCtx)
    }
    return {}
  }

  return {
    SessionStart: [{
      hooks: [onSessionStart],
    }],

    SessionEnd: [{
      hooks: [onSessionEnd],
    }],

    UserPromptSubmit: [{
      hooks: [onUserPromptSubmit],
    }],

    Stop: [{
      hooks: [onStop],
    }],

    PreToolUse: [{
      hooks: [onPreToolUse],
    }],

    PostToolUse: [{
      hooks: [onPostToolUse],
    }],

    PostToolUseFailure: [{
      hooks: [onPostToolUseFailure],
    }],

    SubagentStart: [{
      hooks: [onSubagentStart],
    }],

    SubagentStop: [{
      hooks: [onSubagentStop],
    }],
  }
}

// Close any pending spans when the session ends (iterator exhaustion or abort).
function finishSession (sessionCtx) {
  if (sessionCtx._finished) return
  sessionCtx._finished = true

  if (sessionCtx.currentTurn) {
    turnCh.end.publish(sessionCtx.currentTurn)
    turnCh.asyncEnd.publish(sessionCtx.currentTurn)
    sessionCtx.currentTurn = null
  }
  for (const toolCtx of sessionCtx.pendingTools.values()) {
    toolCh.end.publish(toolCtx)
    toolCh.asyncEnd.publish(toolCtx)
  }
  sessionCtx.pendingTools.clear()
  for (const subCtx of sessionCtx.pendingSubagents.values()) {
    subagentCh.end.publish(subCtx)
    subagentCh.asyncEnd.publish(subCtx)
  }
  sessionCtx.pendingSubagents.clear()
}

function onQueryStart (ctx) {
  const { arguments: args } = ctx

  const queryArg = args[0]
  if (!queryArg || !turnCh.start.hasSubscribers) return

  const prompt = queryArg.prompt
  const sessionPrompt = typeof prompt === 'string' ? prompt : '[async iterable]'
  const resolvedOptions = queryArg.options || {}

  const sessionCtx = {
    prompt: sessionPrompt,
    model: resolvedOptions.model,
    resume: resolvedOptions.resume,
    maxTurns: resolvedOptions.maxTurns,
    permissionMode: resolvedOptions.permissionMode,
    currentTurn: null,
    pendingTools: new Map(),
    pendingSubagents: new Map(),
  }

  const tracerHooks = buildTracerHooks(sessionCtx)

  args[0] = {
    ...queryArg,
    options: {
      ...resolvedOptions,
      hooks: mergeHooks(resolvedOptions.hooks, tracerHooks),
    },
  }

  ctx._sessionCtx = sessionCtx
}

queryChannel.subscribe({
  start: onQueryStart,
})

for (const hook of getHooks('@anthropic-ai/claude-agent-sdk')) {
  hook.file = null

  addHook(hook, exports => exports)
}
