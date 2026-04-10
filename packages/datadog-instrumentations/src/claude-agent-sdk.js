'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const sessionCh = tracingChannel('apm:claude-agent-sdk:session')
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
        sessionCtx.permissionMode = input.permission_mode
        return {}
      }],
    }],

    SessionEnd: [{
      hooks: [function onSessionEnd (input) {
        sessionCtx.endReason = input.reason
        sessionCh.asyncEnd.publish(sessionCtx)
        return {}
      }],
    }],

    UserPromptSubmit: [{
      hooks: [function onUserPromptSubmit (input) {
        const turnCtx = {
          sessionId: input.session_id,
          prompt: input.prompt,
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

/**
 * Core interception logic: build a sessionCtx, inject tracer hooks into
 * options.hooks, and run the call inside sessionCh tracing stores.
 */
function interceptQuery (prompt, options, callOriginal) {
  if (!sessionCh.start.hasSubscribers) {
    return callOriginal(prompt, options)
  }

  const resolvedOptions = options || {}
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
  const mergedOptions = {
    ...resolvedOptions,
    hooks: mergeHooks(resolvedOptions.hooks, tracerHooks),
  }

  return sessionCh.start.runStores(sessionCtx, () => {
    let result
    try {
      result = callOriginal(prompt, mergedOptions)
    } catch (err) {
      sessionCtx.error = err
      sessionCh.error.publish(sessionCtx)
      sessionCh.asyncEnd.publish(sessionCtx)
      throw err
    }

    sessionCh.end.publish(sessionCtx)

    // If query() returns a promise/thenable, catch rejections
    if (result && typeof result.then === 'function') {
      result.then(null, (err) => {
        sessionCtx.error = err
        sessionCh.error.publish(sessionCtx)
        sessionCh.asyncEnd.publish(sessionCtx)
      })
    }

    return result
  })
}

// --- Orchestrion path (primary) ---
// Subscribe eagerly to the orchestrion channel. The rewriter transforms the SDK
// at _compile time (which works on Node 22 for ESM-via-require), but RITM can't
// match ESM modules on Node 22. Subscribing outside addHook ensures the channel
// has a listener before query() is called regardless of RITM.

const queryChannel = tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query')
queryChannel.subscribe({
  start (ctx) {
    const { arguments: args } = ctx

    const queryArg = args[0]
    if (!queryArg || !sessionCh.start.hasSubscribers) return

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
    sessionCh.start.publish(sessionCtx)
  },

  end (ctx) {
    const sessionCtx = ctx._sessionCtx
    if (sessionCtx) {
      sessionCh.end.publish(sessionCtx)
    }
  },

  asyncEnd (ctx) {
    const sessionCtx = ctx._sessionCtx
    if (sessionCtx) {
      sessionCh.asyncEnd.publish(sessionCtx)
    }
  },

  error (ctx) {
    const sessionCtx = ctx._sessionCtx
    if (sessionCtx) {
      sessionCtx.error = ctx.error
      sessionCh.error.publish(sessionCtx)
    }
  },
})

// --- Shimmer fallback path ---
// Kept for environments where the orchestrion rewriter is not active.
// The addHook registration ensures shimmer.wrap runs when the module is loaded
// without rewriting.

addHook({
  name: '@anthropic-ai/claude-agent-sdk',
  file: 'sdk.mjs',
  versions: ['>=0.2.0'],
}, (exports) => {
  shimmer.wrap(exports, 'query', function wrapQuery (originalQuery) {
    return function wrappedQuery ({ prompt, options }) {
      return interceptQuery(prompt, options, (p, opts) => {
        return originalQuery.call(this, { prompt: p, options: opts })
      })
    }
  })
  return exports
})
