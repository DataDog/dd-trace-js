'use strict'

const { tracingChannel } = require('dc-polyfill')
const { addHook, getHooks } = require('./helpers/instrument')
const queryChannel = tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query')

const turnCh = tracingChannel('apm:claude-agent-sdk:turn')
const toolCh = tracingChannel('apm:claude-agent-sdk:tool')
const subagentCh = tracingChannel('apm:claude-agent-sdk:subagent')

function mergeHooks (userHooks, tracerHooks) {
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
  return {
    SessionStart: [{
      hooks: [function onSessionStart (input) {
        sessionCtx.sessionId = input.session_id
        sessionCtx.source = input.source
        sessionCtx.cwd = input.cwd
        sessionCtx.transcriptPath = input.transcript_path
        sessionCtx.agentType = input.agent_type
        sessionCtx.permissionMode = sessionCtx.permissionMode || input.permission_mode
        return {}
      }],
    }],

    SessionEnd: [{
      hooks: [function onSessionEnd (input) {
        sessionCtx.endReason = input.reason
        finishSession(sessionCtx)
        return {}
      }],
    }],

    UserPromptSubmit: [{
      hooks: [function onUserPromptSubmit (input) {
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
        turnCh.start.runStores(turnCtx, () => {
          turnCh.end.publish(turnCtx)
        })
        return {}
      }],
    }],

    Stop: [{
      hooks: [function onStop (input) {
        const turnCtx = sessionCtx.currentTurn
        if (turnCtx) {
          turnCtx.stopReason = input.stop_reason
          turnCtx.lastAssistantMessage = input.last_assistant_message
          turnCh.asyncEnd.publish(turnCtx)
          sessionCtx.currentTurn = null
        }
        sessionCtx.lastAssistantMessage = input.last_assistant_message
        return {}
      }],
    }],

    PreToolUse: [{
      hooks: [function onPreToolUse (input, toolUseId) {
        const id = toolUseId || input.tool_use_id
        if (!id) return {}

        const toolCtx = {
          sessionId: input.session_id,
          toolName: input.tool_name,
          toolInput: input.tool_input,
          toolUseId: id,
        }

        sessionCtx.pendingTools.set(id, toolCtx)
        toolCh.start.runStores(toolCtx, () => {
          toolCh.end.publish(toolCtx)
        })
        return {}
      }],
    }],

    PostToolUse: [{
      hooks: [function onPostToolUse (input, toolUseId) {
        const id = toolUseId || input.tool_use_id
        const toolCtx = sessionCtx.pendingTools.get(id)
        if (toolCtx) {
          toolCtx.toolResponse = input.tool_response
          toolCtx.toolName = toolCtx.toolName || input.tool_name
          sessionCtx.pendingTools.delete(id)
          toolCh.asyncEnd.publish(toolCtx)
        }
        return {}
      }],
    }],

    PostToolUseFailure: [{
      hooks: [function onPostToolUseFailure (input, toolUseId) {
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
      }],
    }],

    SubagentStart: [{
      hooks: [function onSubagentStart (input) {
        const agentId = input.agent_id
        if (!agentId) return {}

        const subagentCtx = {
          sessionId: input.session_id,
          agentId,
          agentType: input.agent_type,
        }

        sessionCtx.pendingSubagents.set(agentId, subagentCtx)
        subagentCh.start.runStores(subagentCtx, () => {
          subagentCh.end.publish(subagentCtx)
        })
        return {}
      }],
    }],

    SubagentStop: [{
      hooks: [function onSubagentStop (input) {
        const agentId = input.agent_id
        const subagentCtx = sessionCtx.pendingSubagents.get(agentId)
        if (subagentCtx) {
          subagentCtx.transcriptPath = input.agent_transcript_path
          subagentCtx.lastAssistantMessage = input.last_assistant_message
          subagentCtx.agentType = subagentCtx.agentType || input.agent_type
          sessionCtx.pendingSubagents.delete(agentId)
          subagentCh.asyncEnd.publish(subagentCtx)
        }
        return {}
      }],
    }],
  }
}

// Close any pending spans when the session ends (iterator exhaustion or abort).
function finishSession (sessionCtx) {
  if (sessionCtx._finished) return
  sessionCtx._finished = true

  if (sessionCtx.currentTurn) {
    turnCh.asyncEnd.publish(sessionCtx.currentTurn)
    sessionCtx.currentTurn = null
  }
  for (const toolCtx of sessionCtx.pendingTools.values()) {
    toolCh.asyncEnd.publish(toolCtx)
  }
  sessionCtx.pendingTools.clear()
  for (const subCtx of sessionCtx.pendingSubagents.values()) {
    subagentCh.asyncEnd.publish(subCtx)
  }
  sessionCtx.pendingSubagents.clear()
}

// --- Orchestrion path (primary) ---
// Subscribe to the orchestrion channel via getHooks/addHook. The rewriter
// transforms the SDK at compile time, which works on Node 22 for ESM-via-require.

for (const hook of getHooks('@anthropic-ai/claude-agent-sdk')) {
  if (hook.file === 'sdk.mjs') {
    hook.file = null
  }

  addHook(hook, exports => {
    queryChannel.subscribe({
      start (ctx) {
        const { arguments: args } = ctx

        const queryArg = args[0]
        if (!queryArg || !turnCh.start.hasSubscribers) return

        const prompt = queryArg.prompt
        const resolvedOptions = queryArg.options || {}

        const sessionCtx = {
          prompt: typeof prompt === 'string' ? prompt : '[async iterable]',
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
      },
    })

    return exports
  })
}
