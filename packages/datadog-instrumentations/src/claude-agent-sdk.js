'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')
const queryChannel = tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query')

const stepCh = tracingChannel('apm:claude-agent-sdk:step')
const llmCh = tracingChannel('apm:claude-agent-sdk:llm')
const toolCh = tracingChannel('apm:claude-agent-sdk:tool')

const LOCAL_LIFECYCLE_LOOKAHEAD = 4

const chunkEmitTimes = new WeakMap()

function mergeHooks (userHooks, tracerHooks) {
  const merged = {}

  for (const event of Object.keys(tracerHooks)) {
    const userMatchers = userHooks?.[event] || []
    merged[event] = [...userMatchers, ...tracerHooks[event]]
  }

  if (userHooks) {
    for (const event of Object.keys(userHooks)) {
      if (!merged[event]) merged[event] = userHooks[event]
    }
  }

  return merged
}

function getTool (sessionCtx, id) {
  let tool = sessionCtx.tools.get(id)
  if (!tool) {
    tool = { id }
    sessionCtx.tools.set(id, tool)
  }
  return tool
}

function buildTracerHooks (sessionCtx) {
  function onSessionStart (input) {
    sessionCtx.sessionId = input.session_id
    sessionCtx.source = input.source
    sessionCtx.cwd = input.cwd
    sessionCtx.transcriptPath = input.transcript_path
    sessionCtx.agentType = input.agent_type
    sessionCtx.permissionMode = sessionCtx.permissionMode || input.permission_mode
    return {}
  }

  function onSessionEnd (input) {
    sessionCtx.endReason = input.reason
    return {}
  }

  function onUserPromptSubmit (input) {
    sessionCtx.sessionId = sessionCtx.sessionId || input.session_id
    sessionCtx.prompt = sessionCtx.prompt || input.prompt
    return {}
  }

  function onStop (input) {
    sessionCtx.stopReason = input.stop_reason
    sessionCtx.lastAssistantMessage = input.last_assistant_message
    return {}
  }

  function onPreToolUse (input, toolUseId) {
    const id = toolUseId || input.tool_use_id
    if (!id) return {}

    Object.assign(getTool(sessionCtx, id), {
      id,
      name: input.tool_name,
      input: input.tool_input,
      sessionId: input.session_id,
      hookStartTime: Date.now(),
    })
    return {}
  }

  function onPostToolUse (input, toolUseId) {
    const id = toolUseId || input.tool_use_id
    if (!id) return {}

    Object.assign(getTool(sessionCtx, id), {
      id,
      name: input.tool_name || sessionCtx.tools.get(id)?.name,
      output: input.tool_response,
      sessionId: input.session_id,
      hookFinishTime: Date.now(),
    })
    return {}
  }

  function onPostToolUseFailure (input, toolUseId) {
    const id = toolUseId || input.tool_use_id
    if (!id) return {}

    Object.assign(getTool(sessionCtx, id), {
      id,
      error: input.error,
      isInterrupt: input.is_interrupt,
      sessionId: input.session_id,
      hookFinishTime: Date.now(),
    })
    return {}
  }

  function onSubagentStart (input) {
    const id = input.agent_id
    if (!id) return {}

    sessionCtx.subagents.set(id, {
      id,
      sessionId: input.session_id,
      agentType: input.agent_type,
      hookStartTime: Date.now(),
    })
    return {}
  }

  function onSubagentStop (input) {
    const id = input.agent_id
    if (!id) return {}

    const subagent = sessionCtx.subagents.get(id) || { id }
    Object.assign(subagent, {
      sessionId: input.session_id,
      agentType: input.agent_type || subagent.agentType,
      transcriptPath: input.agent_transcript_path,
      output: input.last_assistant_message,
      hookFinishTime: Date.now(),
    })
    sessionCtx.subagents.set(id, subagent)
    return {}
  }

  return {
    SessionStart: [{ hooks: [onSessionStart] }],
    SessionEnd: [{ hooks: [onSessionEnd] }],
    UserPromptSubmit: [{ hooks: [onUserPromptSubmit] }],
    Stop: [{ hooks: [onStop] }],
    PreToolUse: [{ hooks: [onPreToolUse] }],
    PostToolUse: [{ hooks: [onPostToolUse] }],
    PostToolUseFailure: [{ hooks: [onPostToolUseFailure] }],
    SubagentStart: [{ hooks: [onSubagentStart] }],
    SubagentStop: [{ hooks: [onSubagentStop] }],
  }
}

function onQueryStart (ctx) {
  const { arguments: args } = ctx
  const queryArg = args?.[0]
  if (!queryArg) return

  const options = queryArg.options || {}
  const prompt = queryArg.prompt
  const sessionCtx = {
    prompt: typeof prompt === 'string' ? prompt : undefined,
    model: options.model,
    resume: options.resume,
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    tools: new Map(),
    subagents: new Map(),
  }

  args[0] = {
    ...queryArg,
    options: {
      ...options,
      hooks: mergeHooks(options.hooks, buildTracerHooks(sessionCtx)),
    },
  }
  ctx.sessionCtx = sessionCtx
}

function buildStreamIndex (chunks) {
  const lifecycleByToolId = new Map()

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    if (chunk.type === 'system' && chunk.subtype === 'task_started' && chunk.tool_use_id) {
      const lifecycle = lifecycleByToolId.get(chunk.tool_use_id) || {}
      lifecycle.taskStartedChunk = chunk
      lifecycleByToolId.set(chunk.tool_use_id, lifecycle)
    } else if (chunk.type === 'user') {
      const content = chunk.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const lifecycle = lifecycleByToolId.get(block.tool_use_id) || {}
          if (lifecycle.toolResultIndex === undefined) lifecycle.toolResultIndex = idx
          lifecycleByToolId.set(block.tool_use_id, lifecycle)
        }
      }
    }
  }

  return lifecycleByToolId
}

function scanLocalLifecycle (chunks, startIndex, toolUseId, lifecycle) {
  lifecycle.taskStartedChunk = undefined
  lifecycle.toolResultIndex = undefined

  const scanEnd = Math.min(chunks.length, startIndex + LOCAL_LIFECYCLE_LOOKAHEAD)

  for (let idx = startIndex; idx < scanEnd; idx++) {
    const chunk = chunks[idx]
    if (chunk.type === 'system' && chunk.subtype === 'task_started' && chunk.tool_use_id === toolUseId) {
      lifecycle.taskStartedChunk = chunk
    } else if (chunk.type === 'user') {
      const content = chunk.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
          lifecycle.toolResultIndex = idx
          return lifecycle
        }
      }
    }
  }

  return lifecycle
}

function createStreamLookup (chunks) {
  let streamIndex
  const localLifecycle = {}

  return function getLifecycle (startIndex, toolUseId) {
    if (streamIndex) return streamIndex.get(toolUseId) || {}

    scanLocalLifecycle(chunks, startIndex, toolUseId, localLifecycle)
    if (localLifecycle.toolResultIndex !== undefined) return localLifecycle

    streamIndex = streamIndex || buildStreamIndex(chunks)
    const indexedLifecycle = streamIndex.get(toolUseId)
    return {
      taskStartedChunk: localLifecycle.taskStartedChunk || indexedLifecycle?.taskStartedChunk,
      toolResultIndex: indexedLifecycle?.toolResultIndex,
    }
  }
}

/**
 *
 * @param {Array<Record<string, unknown>>} chunks
 * @param {number} startIndex
 * @param {string} toolUseId
 * @returns {number} index in chunks where the next step should start iteration
 */
function processTool (chunks, startIndex, toolUseId, sessionCtx, getLifecycle, lifecycle) {
  let chunkIndex = startIndex
  let stepIndex = 0
  const tool = sessionCtx?.tools.get(toolUseId)
  const toolResultIndex = lifecycle.toolResultIndex
  const scanEnd = toolResultIndex === undefined ? chunks.length : toolResultIndex + 1

  while (chunkIndex < scanEnd) {
    const chunk = chunks[chunkIndex]

    if (chunkIndex === toolResultIndex) return chunkIndex + 1

    // only process steps for assistant chunks that belong to this subagent invocation
    if (chunk.type === 'assistant' && chunk.parent_tool_use_id === toolUseId) {
      let prevIdx = chunkIndex - 1
      while (prevIdx >= 0 && chunks[prevIdx].type === 'system') prevIdx--
      const prevChunk = prevIdx >= 0 ? chunks[prevIdx] : chunk
      const stepCtx = {
        stepIndex,
        startTime: chunkEmitTimes.get(prevChunk),
        parentToolUseId: toolUseId,
        sessionId: chunks[0]?.session_id,
      }
      chunkIndex = stepCh.traceSync(() => {
        const nextIdx = processStep(
          chunks,
          chunkIndex,
          stepCtx.startTime,
          toolUseId,
          undefined,
          stepCtx,
          sessionCtx,
          getLifecycle
        )
        stepCtx.finishTime = chunkEmitTimes.get(chunks[Math.min(nextIdx - 1, chunks.length - 1)])
        return nextIdx
      }, stepCtx)
      stepIndex++
    } else {
      chunkIndex++
    }
  }

  if (tool?.hookFinishTime) return chunks.length

  return chunks.length + 1
}

/**
 *
 * @param {Array<Record<string, unknown>>} chunks
 * @param {number} startIndex
 * @returns {number} index in chunks where the next step should start iteration
 */
function processStep (
  chunks,
  startIndex,
  stepStartTime,
  parentToolUseId = null,
  initialPrompt,
  stepCtx = null,
  sessionCtx = null,
  getLifecycle
) {
  for (let idx = startIndex; idx < chunks.length; idx++) {
    const chunk = chunks[idx]

    if (chunk.type !== 'assistant') continue

    const { id: messageId, model, usage } = chunk.message

    // collect all chunks belonging to the same message (parallel tool_uses arrive as separate chunks)
    const toolUses = []
    let messageEndIdx = idx
    for (let j = idx; j < chunks.length; j++) {
      const c = chunks[j]
      if (c.type !== 'assistant' || c.message.id !== messageId) break
      if (c.message.content[0]?.type === 'tool_use') {
        toolUses.push({ toolUse: c.message.content[0], startTime: chunkEmitTimes.get(c) })
      }
      messageEndIdx = j + 1
    }

    if (stepCtx) {
      stepCtx.chunks = chunks
      stepCtx.llmStartIdx = idx
      stepCtx.llmEndIdx = messageEndIdx
      stepCtx.toolOutputs = []
    }

    llmCh.traceSync(() => {}, {
      model,
      usage,
      startTime: stepStartTime,
      finishTime: chunkEmitTimes.get(chunks[messageEndIdx - 1]),
      chunks,
      llmStartIdx: idx,
      llmEndIdx: messageEndIdx,
      parentToolUseId,
      initialPrompt,
      sessionId: chunks[0]?.session_id,
    })

    if (toolUses.length === 0) {
      return messageEndIdx
    }

    // for parallel tool calls, each processTool starts from the same messageEndIdx
    // and independently scans for its own tool_result; take the max to advance past all results
    let nextIdx = messageEndIdx
    for (const { toolUse: { id, name, input }, startTime: toolUseStartTime } of toolUses) {
      const hookTool = sessionCtx?.tools.get(id)
      const lifecycle = getLifecycle(messageEndIdx, id)
      // Agent tools emit a system:task_started chunk with a more precise start time
      const taskStartedChunk = lifecycle.taskStartedChunk
      const toolCtx = {
        id,
        name: hookTool?.name || name,
        input: hookTool?.input || input,
        startTime: hookTool?.hookStartTime ||
          (taskStartedChunk ? chunkEmitTimes.get(taskStartedChunk) : toolUseStartTime),
        sessionId: chunks[0]?.session_id,
      }
      const toolEndIdx = toolCh.traceSync(() => {
        const endIdx = processTool(chunks, messageEndIdx, id, sessionCtx, getLifecycle, lifecycle)
        const resultChunk = chunks[endIdx - 1]
        if (hookTool?.error) toolCtx.error = hookTool.error
        if (hookTool?.isInterrupt) toolCtx.isInterrupt = hookTool.isInterrupt
        if (resultChunk?.type === 'user') {
          toolCtx.output = resultChunk.message?.content
        } else if (hookTool?.output) {
          toolCtx.output = hookTool.output
        }
        toolCtx.finishTime = hookTool?.hookFinishTime ||
          chunkEmitTimes.get(chunks[Math.min(endIdx - 1, chunks.length - 1)])
        return endIdx
      }, toolCtx)

      if (stepCtx && toolCtx.output) stepCtx.toolOutputs.push(toolCtx.output)

      nextIdx = Math.max(nextIdx, toolEndIdx)
    }

    return nextIdx
  }

  return chunks.length + 1
}

/**
 * @param {Array<Record<string, unknown>>} chunks
 */
function processChunks (chunks, agentCtx) {
  let chunkIndex = 0
  let stepIndex = 0
  const sessionCtx = agentCtx.sessionCtx
  const getLifecycle = createStreamLookup(chunks)

  const { type, subtype, ...rest } = chunks[0]
  Object.assign(agentCtx, rest)
  if (sessionCtx) {
    if (sessionCtx.sessionId) agentCtx.session_id = sessionCtx.sessionId
    if (sessionCtx.cwd) agentCtx.cwd = sessionCtx.cwd
    if (sessionCtx.permissionMode) agentCtx.permissionMode = sessionCtx.permissionMode
    if (sessionCtx.lastAssistantMessage && !agentCtx.output) agentCtx.output = sessionCtx.lastAssistantMessage
  }

  while (chunkIndex < chunks.length) {
    if (chunks[chunkIndex].type === 'result') break

    const prevChunk = chunkIndex > 0 ? chunks[chunkIndex - 1] : chunks[chunkIndex]
    const stepCtx = { stepIndex, startTime: chunkEmitTimes.get(prevChunk), sessionId: agentCtx.session_id }

    const run = agentCtx.runInContext ?? (fn => fn())
    chunkIndex = run(() => stepCh.traceSync(() => {
      const initialPrompt = sessionCtx?.prompt || agentCtx.arguments?.[0]?.prompt
      const nextIdx = processStep(
        chunks,
        chunkIndex,
        stepCtx.startTime,
        null,
        initialPrompt,
        stepCtx,
        sessionCtx,
        getLifecycle
      )
      stepCtx.finishTime = chunkEmitTimes.get(chunks[Math.min(nextIdx - 1, chunks.length - 1)])
      return nextIdx
    }, stepCtx))

    stepIndex++
  }
}

function wrapQueryAsyncIterator (asyncIterator, ctx) {
  const chunks = []

  return function () {
    const iterator = asyncIterator.apply(this, arguments)
    iterator.next = shimmer.wrapCallback(iterator.next, next => function () {
      return next.apply(this, arguments).then(result => {
        const { done, value } = result

        if (!done && value) {
          const chunkEmitTime = Date.now()
          chunks.push(value)
          chunkEmitTimes.set(value, chunkEmitTime)
        } else {
          const lastChunk = chunks[chunks.length - 1]
          if (lastChunk?.type === 'result') ctx.output = lastChunk.result
          processChunks(chunks, ctx)

          ctx.streamResolved = true
          queryChannel.asyncEnd.publish(ctx)
        }

        return result
      }).catch(error => {
        if (chunks.length > 0) {
          try { processChunks(chunks, ctx) } catch {}
        }

        ctx.error = error
        queryChannel.error.publish(ctx)

        ctx.streamResolved = true
        queryChannel.asyncEnd.publish(ctx)

        throw error
      })
    })
    return iterator
  }
}

let querySubscribed = false

for (const hook of getHooks('@anthropic-ai/claude-agent-sdk')) {
  hook.file = null

  addHook(hook, exports => {
    if (!querySubscribed) {
      querySubscribed = true
      queryChannel.subscribe({
        start: onQueryStart,
        end (ctx) {
          const { result } = ctx

          ctx.streamResolved = false

          shimmer.wrap(result, Symbol.asyncIterator, asyncIterator => wrapQueryAsyncIterator(asyncIterator, ctx))
        },
      })
    }

    return exports
  })
}
