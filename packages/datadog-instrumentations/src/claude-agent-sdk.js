'use strict'

const { tracingChannel } = require('dc-polyfill')
const { addHook } = require('./helpers/instrument')

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

        sessionCtx.turnCount = (sessionCtx.turnCount || 0) + 1

        const turnCtx = {
          sessionId: input.session_id,
          prompt: input.prompt,
          turnId: sessionCtx.turnCount,
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

// Wrap async iterable to finish the session span on break, return, or exhaustion.
function wrapAsyncIterable (iterable, sessionCtx) {
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') return iterable

  const origIterator = iterable[Symbol.asyncIterator]()

  return {
    [Symbol.asyncIterator] () {
      return {
        async next () {
          let result
          try {
            result = await origIterator.next()
          } catch (err) {
            sessionCtx.error = err
            finishSession(sessionCtx)
            throw err
          }
          if (result.done) {
            finishSession(sessionCtx)
          }
          return result
        },
        async return (value) {
          finishSession(sessionCtx)
          if (origIterator.return) return await origIterator.return(value)
          return { done: true, value }
        },
        async throw (error) {
          sessionCtx.error = error
          finishSession(sessionCtx)
          if (origIterator.throw) return await origIterator.throw(error)
          throw error
        },
      }
    },
  }
}

// Guard against double-entry: the RITM path wraps query() via Proxy and calls
// interceptQuery, which calls the original query(). If the orchestrion rewriter
// is also active, the original query() publishes on the orchestrion channel,
// which would fire sessionCh.start a second time. This flag prevents that.
let _intercepting = false

function interceptQuery (prompt, options, callOriginal) {
  if (!turnCh.start.hasSubscribers) {
    return callOriginal(prompt, options)
  }
  _intercepting = true

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

  _intercepting = false

  let result
  try {
    result = callOriginal(prompt, mergedOptions)
  } catch (err) {
    finishSession(sessionCtx)
    throw err
  }

  return wrapAsyncIterable(result, sessionCtx)
}

// --- Orchestrion path ---
// Active when the esbuild/webpack rewriter transforms the SDK at compile time.

const queryChannel = tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query')
queryChannel.subscribe({
  start (ctx) {
    if (_intercepting) return

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

// --- RITM path ---
// Active for standard Node.js require() without the orchestrion rewriter.
// ESM namespace objects are sealed, so we use a Proxy instead of shimmer.wrap.

addHook({
  name: '@anthropic-ai/claude-agent-sdk',
  versions: ['>=0.2.0'],
}, (exports) => {
  const originalQuery = exports.query
  if (typeof originalQuery !== 'function') return exports

  function wrappedQuery ({ prompt, options }) {
    return interceptQuery(prompt, options, (p, opts) => {
      return originalQuery({ prompt: p, options: opts })
    })
  }

  return new Proxy(exports, {
    get (target, prop) {
      if (prop === 'query') return wrappedQuery
      return target[prop]
    },
  })
})
