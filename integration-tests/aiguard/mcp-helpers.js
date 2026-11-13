'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')

const express = require('express')
const { after, afterEach, before, beforeEach, it } = require('mocha')

const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')
const startApiMock = require('./api-mock')
const { executeRequest } = require('./util')

// Every value that AI Guard must never receive contains this marker. mcp-app.js uses the same value.
const SECRET = 'SECRET-VALUE'
const LOCAL_ID = /^dd_mcp_[0-9a-f]{32}$/
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+$/

/**
 * The server ID rule of the wire contract, computed independently of the tracer.
 *
 * @param {string} key
 */
function serverId (key) {
  return 'mcp_' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

/**
 * A chat completions model that calls the first tool with the JSON after "CALL " in the last
 * user message, and answers "done" once it gets the tool result.
 *
 * @returns {Promise<import('node:http').Server>}
 */
function startModelMock () {
  const app = express()
  app.use(express.json())
  app.post('/v1/chat/completions', (req, res) => {
    const { messages = [], tools = [], model } = req.body
    const base = {
      id: 'chatcmpl-mcp',
      object: 'chat.completion',
      created: 0,
      model,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
    if (messages.at(-1)?.role === 'tool' || tools.length === 0) {
      const message = { role: 'assistant', content: 'done' }
      res.json({ ...base, choices: [{ index: 0, message, finish_reason: 'stop' }] })
      return
    }

    const user = messages.findLast(message => message.role === 'user')
    const content = typeof user?.content === 'string' ? user.content : ''
    const args = content.startsWith('CALL ') ? content.slice(5) : '{}'
    res.json({
      ...base,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_mcp_1',
            type: 'function',
            function: { name: tools[0].function.name, arguments: args },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
  })
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/**
 * Sets up the sandbox, the AI Guard and model mocks, and a fake agent for each test. The harness
 * starts aiguard/mcp-app.js and reads the evaluate requests that the app sent.
 *
 * @param {string[]} dependencies The packages of the sandbox.
 */
function useMcpApp (dependencies) {
  let api
  let modelApi
  let proc
  let run = 0

  const harness = {
    /** @type {Record<string, string>} */
    envOverrides: {},
    cwd: '',
    sideEffectFile: '',
    url: '',
    /** @type {FakeAgent|undefined} */
    agent: undefined,

    env () {
      return {
        DD_SERVICE: 'ai_guard_mcp_test',
        DD_ENV: 'test',
        DD_TRACE_AGENT_PORT: String(harness.agent?.port),
        DD_AI_GUARD_ENABLED: 'true',
        DD_AI_GUARD_BLOCK: 'true',
        DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
        DD_API_KEY: 'DD_API_KEY',
        DD_APP_KEY: 'DD_APP_KEY',
        OPENAI_BASE_URL: `http://127.0.0.1:${modelApi.address().port}/v1`,
        OPENAI_AGENTS_DISABLE_TRACING: '1',
        MCP_SIDE_EFFECT_FILE: harness.sideEffectFile,
        ...harness.envOverrides,
      }
    },

    startApp () {
      return spawnProc(path.join(harness.cwd, 'aiguard/mcp-app.js'), { cwd: harness.cwd, env: harness.env() })
        .then(started => {
          proc = started
          harness.url = started.url
        })
    },

    /**
     * @param {string} route
     */
    get (route) {
      return executeRequest(`${harness.url}${route}`)
    },

    async state () {
      return (await harness.get('/mcp/state')).body
    },

    /**
     * Returns the tool side effects of the servers of a transport kind.
     *
     * @param {string} transport
     */
    async effects (transport) {
      const { inProcess, stdio } = await harness.state()
      return transport === 'stdio' ? stdio : inProcess
    },

    requests () {
      return api.requests
    },

    attributes () {
      return api.requests.map(request => request.data.attributes)
    },

    mcpEvaluations () {
      return harness.attributes().filter(evaluation => evaluation.mcp_servers)
    },

    directCalls () {
      return harness.attributes().filter(evaluation => evaluation.messages.some(message => {
        return message.tool_calls?.some(toolCall => LOCAL_ID.test(toolCall.id))
      }))
    },

    assertNoSecrets () {
      const sent = JSON.stringify(api.requests)
      assert.ok(!sent.includes(SECRET), 'an evaluate request contains a secret')
      assert.ok(!sent.includes('handshake'), 'an evaluate request contains the initialize handshake name')
      assert.ok(!sent.includes('app-client'), 'an evaluate request contains the client name')
    },

    /**
     * Asserts one direct callTool evaluation and returns its server entry.
     *
     * @param {object} evaluation
     * @param {string} text
     */
    assertDirectCall (evaluation, text) {
      const [message] = evaluation.messages
      const toolCall = message.tool_calls[0]
      assert.strictEqual(evaluation.messages.length, 1)
      assert.match(toolCall.id, LOCAL_ID)
      assert.deepStrictEqual(message, {
        role: 'assistant',
        tool_calls: [{
          id: toolCall.id,
          function: { name: 'write_file', arguments: JSON.stringify({ text }) },
          mcp: { server_id: evaluation.mcp_servers[0].id },
        }],
      })
      assert.strictEqual(evaluation.mcp_servers.length, 1)
      return evaluation.mcp_servers[0]
    },
  }

  useSandbox(dependencies)

  before(async () => {
    harness.cwd = sandboxCwd()
    api = await startApiMock()
    modelApi = await startModelMock()
  })

  after(() => {
    api.close()
    modelApi.close()
  })

  beforeEach(async () => {
    api.requests.length = 0
    harness.sideEffectFile = path.join(harness.cwd, `mcp-side-effects-${++run}.txt`)
    harness.agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await stopProc(proc)
    proc = undefined
    await harness.agent?.stop()
  })

  return harness
}

/**
 * Returns the server entry that a call of the mcp-app.js server of a transport kind must send.
 *
 * @param {string} transport
 * @param {{ url?: string }} sent The sent entry. It gives the local origin of a remote server.
 * @param {string} [name]
 */
function expectedServer (transport, sent, name) {
  const server = transport === 'stdio'
    ? { id: serverId(`stdio|${process.execPath}`), managed_by: 'client', transport, command: process.execPath }
    : { id: serverId(`url|${sent.url}`), managed_by: 'client', transport, url: sent.url }
  if (transport !== 'stdio') assert.match(String(sent.url), LOCAL_ORIGIN)
  return { ...server, ...(name && { name }), tools: { write_file: 'write_file' } }
}

/**
 * Defines the tests of the MCP tool calls that OpenAI Agents makes through the MCP SDK. The
 * versions differ only in the tool result that the agent gets for a blocked call.
 *
 * @param {ReturnType<typeof useMcpApp>} harness
 * @param {Record<string, string|RegExp>} blockedToolOutputs The tool result of a blocked call, for each
 *   transport kind.
 */
function itChecksAgentsMcpToolCalls (harness, blockedToolOutputs) {
  for (const transport of ['stdio', 'streamable_http']) {
    it(`checks each MCP tool call once, with the configured server name (${transport})`, async () => {
      const response = await harness.get(`/mcp/agents?transport=${transport}&text=agent`)

      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.body.output, 'done')
      assert.ok(JSON.stringify(response.body.toolOutputs).includes('wrote agent'))
      assert.deepStrictEqual(await harness.effects(transport), [`${transport}:agent`])
      // Agents copies the MCP schema, so its model calls get generic input and output evaluations.
      // Two model calls make four, and the callTool check makes the fifth.
      assert.strictEqual(harness.attributes().length, 5)
      const evaluations = harness.mcpEvaluations()
      assert.strictEqual(evaluations.length, 1)
      assert.strictEqual(harness.directCalls().length, 1)
      const server = harness.assertDirectCall(evaluations[0], 'agent')
      assert.deepStrictEqual(server, expectedServer(transport, server, 'local-files'))
      harness.assertNoSecrets()
    })

    it(`drops the server name that @openai/agents makes from the command or the URL (${transport})`, async () => {
      const response = await harness.get(`/mcp/agents?transport=${transport}&named=false&text=agent`)

      assert.strictEqual(response.status, 200)
      assert.strictEqual(harness.attributes().length, 5)
      const evaluations = harness.mcpEvaluations()
      assert.strictEqual(evaluations.length, 1)
      const server = harness.assertDirectCall(evaluations[0], 'agent')
      assert.deepStrictEqual(server, expectedServer(transport, server))
      harness.assertNoSecrets()
    })

    it(`keeps the configured server name out of a later direct call (${transport})`, async () => {
      const response = await harness.get(`/mcp/agents?transport=${transport}&text=agent&direct=true`)

      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(await harness.effects(transport), [`${transport}:agent`, `${transport}:direct`])
      const evaluations = harness.mcpEvaluations()
      assert.strictEqual(evaluations.length, 2)
      const agentServer = harness.assertDirectCall(evaluations[0], 'agent')
      const directServer = harness.assertDirectCall(evaluations[1], 'direct')
      assert.deepStrictEqual(agentServer, expectedServer(transport, agentServer, 'local-files'))
      assert.deepStrictEqual(directServer, expectedServer(transport, directServer))
    })

    it(`blocks an MCP tool call before it runs, and the agent gets the block as a tool result (${transport})`,
      async () => {
        // Only the callTool evaluation carries MCP metadata, so only it gets the MCP policy.
        const text = encodeURIComponent('agent [deny-mcp]')
        const response = await harness.get(`/mcp/agents?transport=${transport}&text=${text}`)

        // Agents turns the tool error into a tool result for the model, and the run completes.
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.body.output, 'done')
        assert.strictEqual(response.body.toolOutputs.length, 1)
        const expected = blockedToolOutputs[transport]
        if (typeof expected === 'string') {
          assert.strictEqual(response.body.toolOutputs[0], expected)
        } else {
          assert.match(response.body.toolOutputs[0], expected)
        }
        assert.deepStrictEqual(await harness.effects(transport), [])
        assert.strictEqual(harness.attributes().length, 5)
        const evaluations = harness.mcpEvaluations()
        assert.strictEqual(evaluations.length, 1)
        assert.strictEqual(harness.directCalls().length, 1)
        const server = harness.assertDirectCall(evaluations[0], 'agent [deny-mcp]')
        assert.deepStrictEqual(server, expectedServer(transport, server, 'local-files'))
      })
  }
}

module.exports = {
  LOCAL_ID,
  LOCAL_ORIGIN,
  SECRET,
  expectedServer,
  itChecksAgentsMcpToolCalls,
  serverId,
  startModelMock,
  useMcpApp,
}
