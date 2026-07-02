'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

const TURNS = 12
const TOOLS_PER_TURN = 4

function buildFixture () {
  const chunks = []
  const hookTools = new Map()
  const toolUses = []

  for (let turn = 0; turn < TURNS; turn++) {
    const messageId = `msg-${turn}`
    chunks.push({
      type: 'assistant',
      session_id: 'session-1',
      parent_tool_use_id: null,
      message: {
        id: messageId,
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `turn ${turn}` }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })

    for (let tool = 0; tool < TOOLS_PER_TURN; tool++) {
      const id = `tool-${turn}-${tool}`
      const name = tool % 3 === 0 ? 'Agent' : 'mcp__local__fetch_weather'
      const input = name === 'Agent'
        ? { description: `subagent ${turn}-${tool}`, prompt: `fetch ${turn}-${tool}` }
        : { location: tool % 2 ? 'CA' : 'NY', units: 'fahrenheit' }

      chunks.push({
        type: 'assistant',
        session_id: 'session-1',
        parent_tool_use_id: null,
        message: {
          id: messageId,
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', id, name, input }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      })
      const scanStartIndex = chunks.length
      chunks.push({ type: 'system', subtype: 'task_started', tool_use_id: id })

      if (name === 'Agent') {
        chunks.push({
          type: 'assistant',
          session_id: 'session-1',
          parent_tool_use_id: id,
          message: {
            id: `subagent-${id}`,
            model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', id: `nested-${id}`, name: 'mcp__local__fetch_weather', input }],
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        })
      }

      chunks.push({
        type: 'user',
        session_id: 'session-1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: [{ type: 'text', text: `result ${turn}-${tool}` }],
          }],
        },
      })

      const hookTool = {
        id,
        name,
        input,
        output: { content: `result ${turn}-${tool}` },
      }
      hookTools.set(id, hookTool)
      toolUses.push({ id, name, input, scanStartIndex })
    }
  }

  return { chunks, hookTools, toolUses }
}

function buildStreamIndex (chunks) {
  const taskStartedByToolId = new Map()
  const toolResultIndexById = new Map()

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    if (chunk.type === 'system' && chunk.subtype === 'task_started') {
      taskStartedByToolId.set(chunk.tool_use_id, idx)
    } else if (chunk.type === 'user') {
      const content = chunk.message.content
      for (const block of content) {
        if (block.type === 'tool_result') toolResultIndexById.set(block.tool_use_id, idx)
      }
    }
  }

  return { taskStartedByToolId, toolResultIndexById }
}

function findTaskStartedScan (chunks, startIndex, toolUseId) {
  for (let idx = startIndex; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    if (chunk.type === 'system' && chunk.subtype === 'task_started' && chunk.tool_use_id === toolUseId) return idx
  }
}

function findToolResultScan (chunks, startIndex, toolUseId) {
  for (let idx = startIndex; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    if (chunk.type !== 'user') continue
    const content = chunk.message.content
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) return idx
    }
  }
}

function runStreamScan (chunks, toolUses) {
  let sink = 0
  for (const toolUse of toolUses) {
    const taskStartedIndex = findTaskStartedScan(chunks, toolUse.scanStartIndex, toolUse.id)
    const resultIndex = findToolResultScan(chunks, toolUse.scanStartIndex, toolUse.id)
    sink += toolUse.name.length + taskStartedIndex + resultIndex
  }
  return sink
}

function runHookIndexed (hookTools, streamIndex, toolUses) {
  let sink = 0
  for (const toolUse of toolUses) {
    const tool = hookTools.get(toolUse.id)
    const taskStartedIndex = streamIndex.taskStartedByToolId.get(toolUse.id)
    const resultIndex = streamIndex.toolResultIndexById.get(toolUse.id)
    sink += tool.name.length + taskStartedIndex + resultIndex
  }
  return sink
}

const { chunks, hookTools, toolUses } = buildFixture()
const streamIndex = buildStreamIndex(chunks)
const expected = runStreamScan(chunks, toolUses)
assert.equal(runHookIndexed(hookTools, streamIndex, toolUses), expected)

let sink = 0
guard.loopStart()
if (VARIANT === 'stream-scan') {
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    sink += runStreamScan(chunks, toolUses)
  }
} else if (VARIANT === 'hook-indexed') {
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    sink += runHookIndexed(hookTools, streamIndex, toolUses)
  }
} else {
  throw new Error(`Unknown VARIANT: ${VARIANT}`)
}
guard.done()

assert.ok(sink > 0)
