'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')

const { after, afterEach, before, beforeEach } = require('mocha')

const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')
const startApiMock = require('./api-mock')
const { executeRequest } = require('./util')

// Every value that AI Guard must never receive contains this marker. mcp-app.js uses the same value.
const SECRET = 'SECRET-VALUE'
const LOCAL_ID = /^dd_mcp_[0-9a-f]{32}$/
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+$/
// The stdio server runs with the node binary of this process: only its program name is sent.
const NODE_PROGRAM = path.basename(process.execPath).toLowerCase().replace(/\.exe$/, '')

/**
 * The server ID rule of the wire contract, computed independently of the tracer.
 *
 * @param {string} key
 */
function serverId (key) {
  return 'mcp_' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Sets up the sandbox, the AI Guard mock, and a fake agent for each test. The harness
 * starts aiguard/mcp-app.js and reads the evaluate requests that the app sent.
 *
 * @param {string[]} dependencies The packages of the sandbox.
 */
function useMcpApp (dependencies) {
  let api
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
  })

  after(() => {
    api.close()
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
 */
function expectedServer (transport, sent) {
  const server = transport === 'stdio'
    ? { id: serverId(`stdio|${NODE_PROGRAM}`), managed_by: 'client', transport, command: NODE_PROGRAM }
    : { id: serverId(`url|${sent.url}`), managed_by: 'client', transport, url: sent.url }
  if (transport !== 'stdio') assert.match(String(sent.url), LOCAL_ORIGIN)
  return { ...server, tools: { write_file: 'write_file' } }
}

module.exports = {
  LOCAL_ID,
  LOCAL_ORIGIN,
  SECRET,
  expectedServer,
  serverId,
  useMcpApp,
}
