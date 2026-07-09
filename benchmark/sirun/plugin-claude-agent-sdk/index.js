'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const { SCENARIO, VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)
const LOCAL_LIFECYCLE_LOOKAHEAD = 4

const SCENARIOS = {
  compact: {
    turns: 12,
    toolsPerTurn: 4,
    noiseChunks: 0,
    delayedResults: false,
  },
  'delayed-noisy': {
    turns: 8,
    toolsPerTurn: 6,
    noiseChunks: 12,
    delayedResults: true,
  },
}

function pushNoise (chunks, count, label) {
  for (let idx = 0; idx < count; idx++) {
    chunks.push({
      type: 'assistant',
      session_id: 'session-1',
      parent_tool_use_id: null,
      message: {
        id: `${label}-noise-${idx}`,
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `noise ${label}-${idx}` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
  }
}

function pushToolLifecycleChunks (chunks, toolUse, noiseChunks) {
  chunks.push({ type: 'system', subtype: 'task_started', tool_use_id: toolUse.id })

  if (toolUse.name === 'Agent') {
    chunks.push({
      type: 'assistant',
      session_id: 'session-1',
      parent_tool_use_id: toolUse.id,
      message: {
        id: `subagent-${toolUse.id}`,
        model: 'claude-sonnet-4-6',
        content: [{
          type: 'tool_use',
          id: `nested-${toolUse.id}`,
          name: 'mcp__local__fetch_weather',
          input: toolUse.input,
        }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    })
  }

  pushNoise(chunks, noiseChunks, `${toolUse.id}-after-start`)
  chunks.push({
    type: 'user',
    session_id: 'session-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: [{ type: 'text', text: `result ${toolUse.turn}-${toolUse.tool}` }],
      }],
    },
  })
}

function buildFixture (scenario) {
  const chunks = []
  const hookTools = new Map()
  const toolUses = []

  for (let turn = 0; turn < scenario.turns; turn++) {
    const messageId = `msg-${turn}`
    const pendingToolUses = []

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

    for (let tool = 0; tool < scenario.toolsPerTurn; tool++) {
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
      pushNoise(chunks, scenario.delayedResults ? scenario.noiseChunks : 0, `${id}-after-use`)

      const hookTool = {
        id,
        name,
        input,
        output: { content: `result ${turn}-${tool}` },
      }
      hookTools.set(id, hookTool)
      const toolUse = { id, name, input, scanStartIndex, turn, tool }
      toolUses.push(toolUse)

      if (scenario.delayedResults) {
        pendingToolUses.push(toolUse)
      } else {
        pushToolLifecycleChunks(chunks, toolUse, scenario.noiseChunks)
      }
    }

    if (scenario.delayedResults) {
      pushNoise(chunks, scenario.noiseChunks, `turn-${turn}-before-results`)
      for (const toolUse of pendingToolUses) {
        pushToolLifecycleChunks(chunks, toolUse, scenario.noiseChunks)
      }
    }
  }

  return { chunks, hookTools, toolUses }
}

function buildStreamIndex (chunks) {
  const lifecycleByToolId = new Map()

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    if (chunk.type === 'system' && chunk.subtype === 'task_started') {
      const lifecycle = lifecycleByToolId.get(chunk.tool_use_id) || {}
      lifecycle.taskStartedIndex = idx
      lifecycleByToolId.set(chunk.tool_use_id, lifecycle)
    } else if (chunk.type === 'user') {
      const content = chunk.message.content
      for (const block of content) {
        if (block.type === 'tool_result') {
          const lifecycle = lifecycleByToolId.get(block.tool_use_id) || {}
          lifecycle.toolResultIndex = idx
          lifecycleByToolId.set(block.tool_use_id, lifecycle)
        }
      }
    }
  }

  return lifecycleByToolId
}

function scanLocalLifecycle (chunks, startIndex, toolUseId, lifecycle) {
  lifecycle.taskStartedIndex = undefined
  lifecycle.toolResultIndex = undefined

  const scanEnd = Math.min(chunks.length, startIndex + LOCAL_LIFECYCLE_LOOKAHEAD)

  for (let idx = startIndex; idx < scanEnd; idx++) {
    const chunk = chunks[idx]
    if (chunk.type === 'system' && chunk.subtype === 'task_started' && chunk.tool_use_id === toolUseId) {
      lifecycle.taskStartedIndex = idx
    } else if (chunk.type === 'user') {
      const content = chunk.message.content
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
      taskStartedIndex: localLifecycle.taskStartedIndex ?? indexedLifecycle?.taskStartedIndex,
      toolResultIndex: indexedLifecycle?.toolResultIndex,
    }
  }
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

function runHookIndexed (hookTools, getLifecycle, toolUses) {
  let sink = 0
  for (const toolUse of toolUses) {
    const tool = hookTools.get(toolUse.id)
    const lifecycle = getLifecycle(toolUse.scanStartIndex, toolUse.id)
    const taskStartedIndex = lifecycle.taskStartedIndex
    const resultIndex = lifecycle.toolResultIndex
    sink += tool.name.length + taskStartedIndex + resultIndex
  }
  return sink
}

const scenario = SCENARIOS[SCENARIO]
if (scenario === undefined) throw new Error(`Unknown SCENARIO: ${SCENARIO}`)

const { chunks, hookTools, toolUses } = buildFixture(scenario)
const expected = runStreamScan(chunks, toolUses)
assert.equal(runHookIndexed(hookTools, createStreamLookup(chunks), toolUses), expected)

let sink = 0
guard.loopStart()
if (VARIANT === 'stream-scan') {
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    sink += runStreamScan(chunks, toolUses)
  }
} else if (VARIANT === 'hook-indexed') {
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    sink += runHookIndexed(hookTools, createStreamLookup(chunks), toolUses)
  }
} else {
  throw new Error(`Unknown VARIANT: ${VARIANT}`)
}
guard.done()

assert.ok(sink > 0)
