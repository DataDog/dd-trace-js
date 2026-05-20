'use strict'

const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')

const MODEL = 'anthropic/claude-3-5-sonnet-20241022'
const SESSION_ID = 'test-session'

function createFakeClaudeCodeProcess (options = {}) {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const pendingResponses = new Map()
  let buffer = ''
  let exitCode = null
  let hooks
  let killed = false
  let nextRequestId = 0
  let pendingUserMessage
  let turnStarted = false

  const stdin = new Writable({
    write (chunk, encoding, callback) {
      buffer += chunk.toString()

      try {
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (line) handleMessage(JSON.parse(line))
          newlineIndex = buffer.indexOf('\n')
        }
        callback()
      } catch (err) {
        callback(err)
      }
    },
  })

  stdin.on('error', err => emitter.emit('error', err))

  function writeMessage (message) {
    stdout.write(`${JSON.stringify(message)}\n`)
  }

  function finish () {
    if (exitCode !== null) return

    exitCode = 0
    stdout.end()
    emitter.emit('exit', 0, null)
  }

  function kill () {
    if (exitCode !== null) return false

    killed = true
    stdout.end()
    emitter.emit('exit', null, 'SIGTERM')
    return true
  }

  function handleMessage (message) {
    if (message.type === 'control_request') {
      handleControlRequest(message)
      return
    }

    if (message.type === 'control_response') {
      const requestId = message.response.request_id
      const resolve = pendingResponses.get(requestId)
      if (resolve) {
        pendingResponses.delete(requestId)
        resolve()
      }
      return
    }

    if (message.type === 'user') {
      pendingUserMessage = message
      maybeRunTurn()
    }
  }

  function handleControlRequest (message) {
    if (message.request.subtype === 'initialize') {
      hooks = message.request.hooks || {}
      writeMessage({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {
            commands: [],
            models: [],
            agents: [],
          },
        },
      })
      maybeRunTurn()
    }
  }

  function maybeRunTurn () {
    if (turnStarted || hooks === undefined || !pendingUserMessage) return

    turnStarted = true
    runTurn(pendingUserMessage).catch(err => emitter.emit('error', err))
  }

  async function runTurn (message) {
    const prompt = getPrompt(message)

    writeMessage({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
      model: MODEL,
      permissionMode: 'default',
      apiKeySource: 'none',
    })

    if (!options.skipSessionStart) {
      await callHooks('SessionStart', {
        session_id: SESSION_ID,
        source: 'startup',
        cwd: process.cwd(),
        transcript_path: '/tmp/test-transcript.jsonl',
        agent_type: 'main',
        permission_mode: 'default',
      })
    }

    await callHooks('UserPromptSubmit', {
      session_id: SESSION_ID,
      prompt,
    })

    await callHooks('PreToolUse', {
      session_id: SESSION_ID,
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_use_id: 'tool-success',
    })

    await callHooks('SubagentStart', {
      session_id: SESSION_ID,
      agent_id: 'agent-1',
      agent_type: 'search',
    })

    if (!options.leavePendingSpans) {
      await callHooks('PostToolUse', {
        session_id: SESSION_ID,
        tool_name: 'Read',
        tool_response: { content: 'file contents' },
        tool_use_id: 'tool-success',
      })

      await callHooks('PreToolUse', {
        session_id: SESSION_ID,
        tool_name: 'Write',
        tool_input: { file_path: 'README.md', content: 'updated' },
        tool_use_id: 'tool-failure',
      })

      await callHooks('PostToolUseFailure', {
        session_id: SESSION_ID,
        error: { message: 'permission denied' },
        is_interrupt: true,
        tool_use_id: 'tool-failure',
      })

      await callHooks('SubagentStop', {
        session_id: SESSION_ID,
        agent_id: 'agent-1',
        agent_type: 'search',
        agent_transcript_path: '/tmp/test-subagent-transcript.jsonl',
        last_assistant_message: 'Subagent done',
      })

      await callHooks('Stop', {
        session_id: SESSION_ID,
        stop_reason: 'end_turn',
        last_assistant_message: 'Hello',
      })

      if (options.exerciseEdgeHooks) {
        await callEdgeHooks()
      }
    }

    await callHooks('SessionEnd', {
      session_id: SESSION_ID,
      reason: 'clear',
    })

    if (options.exerciseEdgeHooks) {
      await callHooks('SessionEnd', {
        session_id: SESSION_ID,
        reason: 'clear',
      })
    }

    writeMessage({
      type: 'assistant',
      session_id: SESSION_ID,
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: MODEL,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      },
    })

    writeMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello',
      session_id: SESSION_ID,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    })

    finish()
  }

  async function callEdgeHooks () {
    await callHooks('Stop', {
      session_id: SESSION_ID,
      stop_reason: 'end_turn',
      last_assistant_message: 'Hello again',
    })

    await callHooks('PreToolUse', {
      session_id: SESSION_ID,
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    })

    await callHooks('PostToolUse', {
      session_id: SESSION_ID,
      tool_name: 'Read',
      tool_response: { content: 'unused' },
      tool_use_id: 'tool-unknown',
    })

    await callHooks('PostToolUseFailure', {
      session_id: SESSION_ID,
      error: { message: 'unused' },
      is_interrupt: false,
      tool_use_id: 'tool-unknown',
    })

    await callHooks('PreToolUse', {
      session_id: SESSION_ID,
      tool_input: { command: 'pwd' },
      tool_use_id: 'tool-named-late',
    })

    await callHooks('PostToolUse', {
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_response: { output: process.cwd() },
      tool_use_id: 'tool-named-late',
    })

    await callHooks('SubagentStart', {
      session_id: SESSION_ID,
    })

    await callHooks('SubagentStop', {
      session_id: SESSION_ID,
      agent_id: 'agent-unknown',
      agent_type: 'search',
      last_assistant_message: 'unused',
    })

    await callHooks('SubagentStart', {
      session_id: SESSION_ID,
      agent_id: 'agent-2',
    })

    await callHooks('SubagentStop', {
      session_id: SESSION_ID,
      agent_id: 'agent-2',
      agent_type: 'review',
      agent_transcript_path: '/tmp/test-subagent-review-transcript.jsonl',
      last_assistant_message: 'Review done',
    })
  }

  function getPrompt (message) {
    const content = message.message && message.message.content
    if (!Array.isArray(content)) return ''

    for (const item of content) {
      if (item && item.type === 'text') return item.text
    }

    return ''
  }

  async function callHooks (event, input) {
    const eventHooks = hooks && hooks[event]
    if (!eventHooks) return

    for (const eventHook of eventHooks) {
      const callbackIds = eventHook.hookCallbackIds || []
      for (const callbackId of callbackIds) {
        await callHook(callbackId, input)
      }
    }
  }

  function callHook (callbackId, input) {
    return new Promise(resolve => {
      const requestId = `test-hook-${++nextRequestId}`
      pendingResponses.set(requestId, resolve)
      writeMessage({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'hook_callback',
          callback_id: callbackId,
          input,
        },
      })
    })
  }

  return {
    stdin,
    stdout,
    get killed () { return killed },
    get exitCode () { return exitCode },
    kill,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  }
}

module.exports = {
  createFakeClaudeCodeProcess,
}
