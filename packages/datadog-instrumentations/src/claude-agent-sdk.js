'use strict'

// Shimmer is used here because we must merge user-provided Claude hook matchers
// into `options.hooks` at runtime before calling `query()`, which orchestrion
// cannot express without custom argument mutation logic.

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
          turnCh.asyncEnd.publish(turnCtx)
          sessionCtx.currentTurn = null
        }
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
          sessionCtx.pendingSubagents.delete(agentId)
          subagentCh.asyncEnd.publish(subagentCtx)
        }
        return {}
      }],
    }],
  }
}

function wrapQuery (originalQuery) {
  return function wrappedQuery ({ prompt, options }) {
    if (!sessionCh.start.hasSubscribers) {
      return originalQuery.call(this, { prompt, options })
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
        result = originalQuery.call(this, { prompt, options: mergedOptions })
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
}

addHook({
  name: '@anthropic-ai/claude-agent-sdk',
  file: 'sdk.mjs',
  versions: ['>=0.2.0'],
}, (exports) => {
  shimmer.wrap(exports, 'query', wrapQuery)
  return exports
})

// Exported for unit testing
module.exports = { mergeHooks, buildTracerHooks, wrapQuery }
