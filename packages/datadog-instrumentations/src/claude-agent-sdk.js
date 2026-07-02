'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')
const queryChannel = tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query')

const stepCh = tracingChannel('apm:claude-agent-sdk:step')
const llmCh = tracingChannel('apm:claude-agent-sdk:llm')
const toolCh = tracingChannel('apm:claude-agent-sdk:tool')

const chunkEmitTimes = new WeakMap()

/**
 *
 * @param {Array<Record<string, unknown>>} chunks
 * @param {number} startIndex
 * @param {string} toolUseId
 * @returns {number} index in chunks where the next step should start iteration
 */
function processTool (chunks, startIndex, toolUseId) {
  let chunkIndex = startIndex
  let stepIndex = 0

  while (chunkIndex < chunks.length) {
    const chunk = chunks[chunkIndex]

    if (chunk.type === 'user') {
      const outputMessage = chunk.message.content[0]
      if (outputMessage.type === 'tool_result' && outputMessage.tool_use_id === toolUseId) {
        return chunkIndex + 1
      }
    }

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
        const nextIdx = processStep(chunks, chunkIndex, stepCtx.startTime, toolUseId, undefined, stepCtx)
        stepCtx.finishTime = chunkEmitTimes.get(chunks[Math.min(nextIdx - 1, chunks.length - 1)])
        return nextIdx
      }, stepCtx)
      stepIndex++
    } else {
      chunkIndex++
    }
  }

  return chunks.length + 1
}

/**
 *
 * @param {Array<Record<string, unknown>>} chunks
 * @param {number} startIndex
 * @returns {number} index in chunks where the next step should start iteration
 */
function processStep (chunks, startIndex, stepStartTime, parentToolUseId = null, initialPrompt, stepCtx = null) {
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
      // Agent tools emit a system:task_started chunk with a more precise start time
      const taskStartedChunk = chunks.slice(messageEndIdx).find(
        c => c.type === 'system' && c.subtype === 'task_started' && c.tool_use_id === id
      )
      const toolCtx = {
        id,
        name,
        input,
        startTime: taskStartedChunk ? chunkEmitTimes.get(taskStartedChunk) : toolUseStartTime,
        sessionId: chunks[0]?.session_id,
      }
      const toolEndIdx = toolCh.traceSync(() => {
        const endIdx = processTool(chunks, messageEndIdx, id)
        const resultChunk = chunks[endIdx - 1]
        if (resultChunk?.type === 'user') toolCtx.output = resultChunk.message?.content
        toolCtx.finishTime = chunkEmitTimes.get(chunks[Math.min(endIdx - 1, chunks.length - 1)])
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

  const { type, subtype, ...rest } = chunks[0]
  Object.assign(agentCtx, rest)

  while (chunkIndex < chunks.length) {
    if (chunks[chunkIndex].type === 'result') break

    const prevChunk = chunkIndex > 0 ? chunks[chunkIndex - 1] : chunks[chunkIndex]
    const stepCtx = { stepIndex, startTime: chunkEmitTimes.get(prevChunk), sessionId: agentCtx.session_id }

    const run = agentCtx.runInContext ?? (fn => fn())
    chunkIndex = run(() => stepCh.traceSync(() => {
      const initialPrompt = agentCtx.arguments?.[0]?.prompt
      const nextIdx = processStep(chunks, chunkIndex, stepCtx.startTime, null, initialPrompt, stepCtx)
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
          console.log('processing', chunks.length, 'chunks')
          processChunks(chunks, ctx)

          ctx.streamResolved = true
          queryChannel.asyncEnd.publish(ctx)
        }

        return result
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
        end (ctx) {
          console.log('query async end')
          const { result } = ctx

          ctx.streamResolved = false

          shimmer.wrap(result, Symbol.asyncIterator, asyncIterator => wrapQueryAsyncIterator(asyncIterator, ctx))
        },
      })
    }

    return exports
  })
}
