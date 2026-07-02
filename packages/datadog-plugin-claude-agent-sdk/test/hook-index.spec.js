'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

function createFakeDc () {
  const channels = new Map()
  const events = []

  function makeChannel (channelName, subscribers, point) {
    return {
      publish (ctx) {
        events.push({ channelName, point, ctx })
        for (const subscriber of subscribers) {
          subscriber[point]?.(ctx)
        }
      },
      get hasSubscribers () {
        return subscribers.some(subscriber => subscriber[point])
      },
    }
  }

  function tracingChannel (channelName) {
    let channel = channels.get(channelName)
    if (channel) return channel

    const subscribers = []
    channel = {
      subscribe (subscriber) {
        subscribers.push(subscriber)
      },
      unsubscribe (subscriber) {
        const idx = subscribers.indexOf(subscriber)
        if (idx !== -1) subscribers.splice(idx, 1)
      },
      traceSync (fn, ctx) {
        channel.start.publish(ctx)
        try {
          const result = fn()
          channel.end.publish(ctx)
          return result
        } catch (error) {
          ctx.error = error
          channel.error.publish(ctx)
          throw error
        }
      },
    }

    for (const point of ['start', 'end', 'asyncStart', 'asyncEnd', 'error']) {
      channel[point] = makeChannel(channelName, subscribers, point)
    }

    channels.set(channelName, channel)
    return channel
  }

  return { channels, events, tracingChannel }
}

function loadInstrumentation () {
  const fakeDc = createFakeDc()
  let hookCallback

  proxyquire.noPreserveCache().load('../../datadog-instrumentations/src/claude-agent-sdk', {
    'dc-polyfill': fakeDc,
    './helpers/instrument': {
      getHooks: () => [{
        name: '@anthropic-ai/claude-agent-sdk',
        versions: ['>=0.2.113'],
        file: 'sdk.mjs',
      }],
      addHook: (hook, callback) => {
        hookCallback = callback
      },
    },
  })

  hookCallback({})

  return fakeDc
}

async function runHooks (hooks, event, input, toolUseId) {
  const matchers = hooks[event] || []
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      await hook(input, toolUseId)
    }
  }
}

function makeStream (chunks) {
  return {
    [Symbol.asyncIterator] () {
      let idx = 0
      return {
        next () {
          if (idx >= chunks.length) return Promise.resolve({ done: true })

          return Promise.resolve({ done: false, value: chunks[idx++] })
        },
      }
    },
  }
}

function makeFailingStream (chunks, error) {
  return {
    [Symbol.asyncIterator] () {
      let idx = 0
      return {
        next () {
          if (idx < chunks.length) return Promise.resolve({ done: false, value: chunks[idx++] })

          return Promise.reject(error)
        },
      }
    },
  }
}

describe('claude-agent-sdk hook index instrumentation', () => {
  it('merges SDK hooks and enriches spans from hook lifecycle data', async () => {
    const { channels, events } = loadInstrumentation()
    const queryChannel = channels.get('orchestrion:@anthropic-ai/claude-agent-sdk:query')
    const userPromptSubmissions = []
    const customHook = () => ({})
    const ctx = {
      arguments: [{
        prompt: 'get weather',
        options: {
          model: 'claude-sonnet-4-6',
          resume: 'session-123',
          maxTurns: 3,
          permissionMode: 'acceptEdits',
          hooks: {
            UserPromptSubmit: [{
              hooks: [input => {
                userPromptSubmissions.push(input.prompt)
                return {}
              }],
            }],
            CustomEvent: [{ hooks: [customHook] }],
          },
        },
      }],
      result: makeStream([
        { type: 'system', subtype: 'init', session_id: 'stream-session' },
        {
          type: 'assistant',
          message: {
            id: 'msg-1',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{
              type: 'tool_use',
              id: 'agent-tool',
              name: 'Agent',
              input: { description: 'Weather', prompt: 'ask the subagent' },
            }],
          },
        },
        {
          type: 'system',
          subtype: 'task_started',
          tool_use_id: 'agent-tool',
          session_id: 'stream-session',
        },
        {
          type: 'assistant',
          parent_tool_use_id: 'agent-tool',
          message: {
            id: 'sub-msg-1',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 3, output_tokens: 4 },
            content: [{ type: 'text', text: 'subagent says hello' }],
          },
        },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'agent-tool',
              content: 'subagent result',
            }],
          },
        },
        {
          type: 'assistant',
          message: {
            id: 'msg-2',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{
              type: 'tool_use',
              id: 'tool-success',
              name: 'mcp__local__fetch_weather',
              input: { location: 'CA' },
            }],
          },
        },
        {
          type: 'assistant',
          message: {
            id: 'msg-2',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{
              type: 'tool_use',
              id: 'tool-failure',
              name: 'mcp__local__fetch_weather',
              input: { location: 'NY' },
            }],
          },
        },
        {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-success',
              content: 'CA is 72F',
            }],
          },
        },
        { type: 'result', result: 'done' },
      ]),
    }

    queryChannel.start.publish(ctx)

    const hooks = ctx.arguments[0].options.hooks
    assert.equal(hooks.CustomEvent[0].hooks[0], customHook)

    await runHooks(hooks, 'SessionStart', {
      session_id: 'hook-session',
      source: 'sdk',
      cwd: '/project',
      transcript_path: '/project/transcript.jsonl',
      agent_type: 'main',
      permission_mode: 'default',
    })
    await runHooks(hooks, 'UserPromptSubmit', { session_id: 'hook-session', prompt: 'get weather' })
    await runHooks(hooks, 'SubagentStart', {
      session_id: 'hook-session',
      agent_id: 'agent-1',
      agent_type: 'weather-fetcher',
    })
    await runHooks(hooks, 'SubagentStop', {
      session_id: 'hook-session',
      agent_id: 'agent-1',
      agent_type: 'weather-fetcher',
      agent_transcript_path: '/project/subagent.jsonl',
      last_assistant_message: 'NY is 72F',
    })
    await runHooks(hooks, 'PreToolUse', {
      session_id: 'hook-session',
      tool_use_id: 'tool-success',
      tool_name: 'mcp__local__fetch_weather',
      tool_input: { location: 'CA' },
    })
    await runHooks(hooks, 'PostToolUse', {
      session_id: 'hook-session',
      tool_use_id: 'tool-success',
      tool_response: 'CA is 72F',
    })
    await runHooks(hooks, 'PreToolUse', {
      session_id: 'hook-session',
      tool_use_id: 'agent-tool',
      tool_name: 'Agent',
      tool_input: { description: 'Weather', prompt: 'ask the subagent' },
    })
    await runHooks(hooks, 'PostToolUse', {
      session_id: 'hook-session',
      tool_use_id: 'agent-tool',
      tool_response: 'subagent result',
    })
    await runHooks(hooks, 'PreToolUse', {
      session_id: 'hook-session',
      tool_use_id: 'tool-failure',
      tool_name: 'mcp__local__fetch_weather',
      tool_input: { location: 'NY' },
    })
    await runHooks(hooks, 'PostToolUseFailure', {
      session_id: 'hook-session',
      tool_use_id: 'tool-failure',
      error: 'permission denied',
      is_interrupt: true,
    })
    await runHooks(hooks, 'Stop', {
      stop_reason: 'complete',
      last_assistant_message: 'done',
    })
    await runHooks(hooks, 'SessionEnd', { reason: 'complete' })

    queryChannel.end.publish(ctx)

    for await (const message of ctx.result) {
      assert.ok(message.type)
    }

    assert.deepEqual(userPromptSubmissions, ['get weather'])
    assert.equal(ctx.streamResolved, true)
    assert.equal(ctx.session_id, 'hook-session')
    assert.equal(ctx.cwd, '/project')
    assert.equal(ctx.permissionMode, 'acceptEdits')
    assert.equal(ctx.output, 'done')

    const starts = events.filter(event => event.point === 'start')
    const stepStart = starts.find(event => event.channelName === 'apm:claude-agent-sdk:step')
    const llmStart = starts.find(event => event.channelName === 'apm:claude-agent-sdk:llm')
    const toolStarts = starts.filter(event => event.channelName === 'apm:claude-agent-sdk:tool')

    assert.equal(stepStart.ctx.stepIndex, 0)
    assert.equal(llmStart.ctx.model, 'claude-sonnet-4-6')
    assert.equal(toolStarts.length, 3)

    const agentTool = toolStarts.find(event => event.ctx.id === 'agent-tool').ctx
    assert.equal(agentTool.name, 'Agent')
    assert.deepEqual(agentTool.input, { description: 'Weather', prompt: 'ask the subagent' })

    const successTool = toolStarts.find(event => event.ctx.id === 'tool-success').ctx
    assert.equal(successTool.name, 'mcp__local__fetch_weather')
    assert.deepEqual(successTool.input, { location: 'CA' })
    assert.deepEqual(successTool.output, [{
      type: 'tool_result',
      tool_use_id: 'tool-success',
      content: 'CA is 72F',
    }])

    const failedTool = toolStarts.find(event => event.ctx.id === 'tool-failure').ctx
    assert.equal(failedTool.name, 'mcp__local__fetch_weather')
    assert.equal(failedTool.error, 'permission denied')
    assert.equal(failedTool.isInterrupt, true)

    assert.ok(events.some(event =>
      event.channelName === 'orchestrion:@anthropic-ai/claude-agent-sdk:query' &&
      event.point === 'asyncEnd'
    ))
  })

  it('publishes query errors from the wrapped async iterator', async () => {
    const { channels, events } = loadInstrumentation()
    const queryChannel = channels.get('orchestrion:@anthropic-ai/claude-agent-sdk:query')
    const error = new Error('stream failed')
    const ctx = {
      arguments: [{ prompt: 'hello' }],
      result: makeFailingStream([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'stream-session',
        },
      ], error),
    }

    queryChannel.start.publish(ctx)
    queryChannel.end.publish(ctx)

    const iterator = ctx.result[Symbol.asyncIterator]()
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: {
        type: 'system',
        subtype: 'init',
        session_id: 'stream-session',
      },
    })
    await assert.rejects(iterator.next(), error)

    assert.equal(ctx.error, error)
    assert.ok(events.some(event =>
      event.channelName === 'orchestrion:@anthropic-ai/claude-agent-sdk:query' &&
      event.point === 'error' &&
      event.ctx.error === error
    ))
    assert.ok(events.some(event =>
      event.channelName === 'orchestrion:@anthropic-ai/claude-agent-sdk:query' &&
      event.point === 'asyncEnd'
    ))
  })
})
