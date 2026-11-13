'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

const { storage } = require('../../../datadog-core')
const {
  activeTrace,
  consumeMark,
  createClientServer,
  linkMcpTools,
  recordListedTools,
} = require('../../src/aiguard/mcp')

/** @typedef {import('../../src/aiguard/mcp').McpServer} McpServer */
/** @typedef {import('../../src/aiguard/mcp').TransportInfo} TransportInfo */

const exec = promisify(execFile)
const legacyStorage = storage('legacy')

/**
 * The server ID rule of the wire contract, computed without the tracer.
 *
 * @param {string} key
 */
function serverId (key) {
  return 'mcp_' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Creates a span double whose context belongs to the given local trace.
 *
 * @param {{ started: object[] }} trace
 */
function fakeSpan (trace) {
  const span = { context: () => ({ _trace: trace }) }
  trace.started.push(span)
  return span
}

/**
 * Creates a local trace whose root is an outer operation, and a model request span inside it.
 */
function outerTrace () {
  const trace = { started: /** @type {object[]} */ ([]) }
  const root = fakeSpan(trace)
  const requestSpan = fakeSpan(trace)
  return { trace, root, requestSpan, interceptCtx: { tracingContext: { currentStore: { span: requestSpan } } } }
}

/**
 * @param {{ type?: string, function?: object }} tool
 */
function chatFunction (tool) {
  return tool.type === 'function' ? tool.function : undefined
}

/**
 * Selects every tool call, as a filter for tests that do not check the filter.
 */
function anyToolCall () {
  return true
}

/**
 * Links the request tools and fails the test when no tool links.
 *
 * @param {Parameters<typeof linkMcpTools>} args
 */
function mustLink (...args) {
  const link = linkMcpTools(...args)
  assert.ok(link)
  return link
}

/**
 * Runs the callback that an evaluation which allows the outputs runs.
 *
 * @param {import('../../src/aiguard/mcp').McpToolLink} link
 * @param {Array<object>} outputs
 */
function allow (link, outputs) {
  const evaluation = link.evaluation(outputs, outputs)
  assert.ok(evaluation?.onAllowed)
  evaluation.onAllowed()
}

describe('AI Guard MCP helpers', () => {
  describe('URL origin of a remote server', () => {
    for (const [url, expected] of [
      ['https://mcp.example.com/mcp', 'https://mcp.example.com'],
      ['HTTPS://MCP.Example.COM:443/Mcp/', 'https://mcp.example.com'],
      ['http://mcp.example.com:80/sse', 'http://mcp.example.com'],
      ['http://mcp.example.com:8080/sse', 'http://mcp.example.com:8080'],
      ['https://user:secret@mcp.example.com/mcp?token=abc#frag', 'https://mcp.example.com'],
      ['https://mcp.example.com/api/mcp/s/s3cr3t-t0ken/mcp', 'https://mcp.example.com'],
      ['https://mcp.example.com/mcp;params?q=1', 'https://mcp.example.com'],
      ['http://[::1]:9000/mcp', 'http://[::1]:9000'],
      ['https://mcp.example.com', 'https://mcp.example.com'],
      ['https://mcp.example.com:notaport/mcp', undefined],
      ['/relative/path', undefined],
      ['not a url', undefined],
      ['', undefined],
      ['ws://MCP.Example.com:80/ws?token=abc', 'ws://mcp.example.com'],
      ['ws://mcp.example.com:8080/ws', 'ws://mcp.example.com:8080'],
      ['wss://user:secret@mcp.example.com:443/ws', 'wss://mcp.example.com'],
      ['wss://mcp.example.com:8443/ws', 'wss://mcp.example.com:8443'],
      // A default port of another scheme is not dropped.
      ['http://mcp.example.com:443/mcp', 'http://mcp.example.com:443'],
      // Other schemes keep their port, and their host is lowercased too.
      ['custom://User@MCP.Example.com:7000/path', 'custom://mcp.example.com:7000'],
      ['file:///tmp/server.sock', undefined],
    ]) {
      it(`keeps ${expected} of ${JSON.stringify(url)}`, () => {
        const server = createClientServer({ type: 'streamable_http', url })

        if (expected === undefined) {
          assert.strictEqual(server, undefined)
        } else {
          assert.deepStrictEqual(server, {
            id: serverId(`url|${expected}`),
            managed_by: 'client',
            transport: 'streamable_http',
            url: expected,
          })
        }
      })
    }

    it('reads the URL object that the SDK keeps', () => {
      const server = createClientServer({ type: 'sse', url: new URL('https://user:secret@MCP.example.com/sse?t=1') })

      assert.strictEqual(server?.url, 'https://mcp.example.com')
    })

    it('reports a WebSocket server as an unknown transport with its URL origin', () => {
      const server = createClientServer({ type: 'websocket', url: 'wss://mcp.example.com/ws?token=abc' })

      assert.deepStrictEqual(server, {
        id: serverId('url|wss://mcp.example.com'),
        managed_by: 'client',
        transport: 'unknown',
        url: 'wss://mcp.example.com',
      })
    })
  })

  describe('server ID', () => {
    it('matches the cross-tracer vectors', () => {
      assert.strictEqual(createClientServer({ type: 'sse', url: 'https://mcp.example.com' })?.id, 'mcp_b77bc22583ac5006')
      assert.strictEqual(
        createClientServer({ type: 'stdio', command: 'uvx', args: ['mcp-example'] })?.id,
        'mcp_0f2f11f8cafdbcc5'
      )
      assert.strictEqual(createClientServer({ type: 'in_process' }, 'atlassian')?.id, 'mcp_4b1df2a2d821278c')
    })

    it('uses the first key that applies', () => {
      const byUrl = createClientServer({ type: 'streamable_http', url: 'https://mcp.example.com/mcp' }, 'atlassian')
      const byCommand = createClientServer({ type: 'stdio', command: 'uvx', args: ['mcp-example'] }, 'atlassian')

      assert.strictEqual(byUrl?.id, 'mcp_b77bc22583ac5006')
      assert.strictEqual(byCommand?.id, 'mcp_0f2f11f8cafdbcc5')
    })
  })

  describe('stdio arguments', () => {
    for (const [command, args, expected] of /** @type {Array<[string, unknown, string[]]>} */ ([
      ['npx', ['-y', '@scope/pkg@1.2.3', '--api-key', 'secret'], ['@scope/pkg@1.2.3']],
      ['npx', ['--yes', '-q', 'mcp-server-fetch'], ['mcp-server-fetch']],
      ['/usr/local/bin/NPX.CMD', ['--quiet', 'pkg'], ['pkg']],
      ['bunx', ['pkg@latest'], ['pkg@latest']],
      ['pnpx', ['@modelcontextprotocol/server-everything'], ['@modelcontextprotocol/server-everything']],
      ['uvx', ['mcp-example', '--token', 'secret'], ['mcp-example']],
      ['uvx.exe', ['mcp-example'], ['mcp-example']],
      ['python', ['-m', 'mcp_server.main', '--token', 'secret'], ['mcp_server.main']],
      ['python3', ['-m', 'mcp_server'], ['mcp_server']],
      ['/usr/bin/python3.12', ['-m', 'pkg.module'], ['pkg.module']],
      // The first argument that is not a flag must be a package, or no argument is safe.
      ['npx', ['-y', './local/server.js'], []],
      ['npx', ['--registry', 'https://user:token@registry.example.com', 'pkg'], []],
      ['npx', ['-y', 'https://example.com/pkg.tgz'], []],
      ['npx', ['-y'], []],
      ['npx', ['-y', 42], []],
      ['python', ['-m', 'bad-module'], []],
      ['python', ['server.py', '--token', 'secret'], []],
      ['python', ['-m'], []],
      ['pythonw', ['-m', 'mcp_server'], []],
      ['node', ['server.js', '--token', 'secret'], []],
      ['docker', ['run', '-e', 'TOKEN=secret', 'image'], []],
      ['npx', 'not-an-array', []],
    ])) {
      it(`keeps ${JSON.stringify(expected)} of ${command} ${JSON.stringify(args)}`, () => {
        const server = createClientServer({ type: 'stdio', command, args })

        assert.deepStrictEqual(server, {
          id: serverId(['stdio', command, ...expected].join('|')),
          managed_by: 'client',
          transport: 'stdio',
          command,
          ...(expected.length > 0 ? { args: expected } : {}),
        })
      })
    }
  })

  describe('server entry', () => {
    it('uses the configured name when no URL or command identifies the server', () => {
      assert.deepStrictEqual(createClientServer({ type: 'in_process' }, 'atlassian'), {
        id: 'mcp_4b1df2a2d821278c',
        managed_by: 'client',
        name: 'atlassian',
        transport: 'in_process',
      })
    })

    for (const [description, info] of /** @type {Array<[string, TransportInfo|undefined]>} */ ([
      ['an in-process transport', { type: 'in_process' }],
      ['a custom transport', { type: 'unknown' }],
      ['a remote transport without a URL', { type: 'sse' }],
      ['a remote transport with a relative URL', { type: 'streamable_http', url: '/mcp' }],
      ['a stdio transport without a command', { type: 'stdio', args: ['-y', 'pkg'] }],
      ['a missing transport', undefined],
    ])) {
      it(`has no entry for ${description}`, () => {
        assert.strictEqual(createClientServer(info), undefined)
      })
    }
  })

  describe('model request links', () => {
    const server = /** @type {McpServer} */ (
      createClientServer({ type: 'streamable_http', url: 'https://mcp.example.com/mcp' })
    )

    /**
     * @param {object} client
     * @param {string} name
     */
    function listTool (client, name) {
      const tool = { name, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }
      recordListedTools(client, server, [tool])
      return tool
    }

    it('links a function tool by the identity of its parameters only', () => {
      const client = {}
      const listed = listTool(client, 'search')
      const { interceptCtx } = outerTrace()

      const byName = linkMcpTools([
        { type: 'function', function: { name: 'search', parameters: { ...listed.inputSchema } } },
      ], chatFunction, interceptCtx)
      const bySchema = mustLink([
        { type: 'function', function: { name: 'srv__search', parameters: listed.inputSchema } },
      ], chatFunction, interceptCtx)

      assert.strictEqual(byName, undefined)
      const messages = bySchema.attach([{
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'srv__search', arguments: '{"q":"x"}' } }],
      }], anyToolCall)
      assert.deepStrictEqual(bySchema.evaluation(messages)?.servers, [{ ...server, tools: { srv__search: 'search' } }])
    })

    it('does not link when the model request span is the root of its trace', () => {
      const listed = listTool({}, 'search')
      const trace = { started: [] }
      const requestSpan = fakeSpan(trace)

      const link = linkMcpTools([
        { type: 'function', function: { name: 'search', parameters: listed.inputSchema } },
      ], chatFunction, { tracingContext: { currentStore: { span: requestSpan } } })

      assert.strictEqual(link, undefined)
    })

    it('uses the active trace when the model request has no span', () => {
      const listed = listTool({}, 'search')
      const trace = { started: [] }
      const active = fakeSpan(trace)

      const link = legacyStorage.run({ span: active }, () => linkMcpTools([
        { type: 'function', function: { name: 'search', parameters: listed.inputSchema } },
      ], chatFunction, {}))
      const noTrace = linkMcpTools([
        { type: 'function', function: { name: 'search', parameters: listed.inputSchema } },
      ], chatFunction, {})

      assert.ok(link)
      assert.strictEqual(noTrace, undefined)
    })

    it('attaches mcp with copy-on-write', () => {
      const listed = listTool({}, 'search')
      const { interceptCtx } = outerTrace()
      const link = mustLink([
        { type: 'function', function: { name: 'search', parameters: listed.inputSchema } },
      ], chatFunction, interceptCtx)
      const user = { role: 'user', content: 'Find it' }
      const toolCall = { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
      const other = { id: 'call_2', type: 'function', function: { name: 'other', arguments: '{}' } }
      const assistant = { role: 'assistant', tool_calls: [toolCall, other] }
      const messages = [user, assistant]
      const snapshot = structuredClone(messages)

      const attached = link.attach(messages, anyToolCall)

      assert.deepStrictEqual(messages, snapshot)
      assert.notStrictEqual(attached, messages)
      assert.strictEqual(attached[0], user)
      assert.strictEqual(attached[1].tool_calls[1], other)
      assert.deepStrictEqual(attached[1], {
        role: 'assistant',
        tool_calls: [{ ...toolCall, mcp: { server_id: server.id } }, other],
      })
      assert.strictEqual(link.attach([user], anyToolCall).length, 1)
      assert.deepStrictEqual(link.evaluation([user]), undefined)
    })

    it('attaches mcp only to the tool calls that the filter selects', () => {
      const listed = listTool({}, 'search')
      const { interceptCtx } = outerTrace()
      const link = mustLink([
        { type: 'function', function: { name: 'search', parameters: listed.inputSchema } },
      ], chatFunction, interceptCtx)
      const functionCall = { id: 'call_1', function: { name: 'search', arguments: '{}' } }
      const hostedCall = { id: 'mcp_1', function: { name: 'search', arguments: '{}' } }

      const [attached] = link.attach([{ role: 'assistant', tool_calls: [functionCall, hostedCall] }], toolCall => {
        return toolCall.id === 'call_1'
      })

      assert.deepStrictEqual(attached.tool_calls, [{ ...functionCall, mcp: { server_id: server.id } }, hostedCall])
    })

    it('marks allowed outputs for the client, original name and canonical arguments', () => {
      const client = {}
      const listed = listTool(client, 'search')
      const { trace, root, interceptCtx } = outerTrace()
      const link = mustLink([
        { type: 'function', function: { name: 'srv__search', parameters: listed.inputSchema } },
      ], chatFunction, interceptCtx)
      const outputs = link.attach([{
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', function: { name: 'srv__search', arguments: '{ "q": "x" }' } },
          { id: 'call_2', function: { name: 'srv__search', arguments: 'not json' } },
        ],
      }], anyToolCall)

      allow(link, outputs)

      assert.strictEqual(legacyStorage.run({ span: root }, activeTrace), trace)
      assert.strictEqual(consumeMark(trace, {}, 'search', '{"q":"x"}'), false)
      assert.strictEqual(consumeMark(trace, client, 'srv__search', '{"q":"x"}'), false)
      assert.strictEqual(consumeMark(trace, client, 'search', '{"q":"y"}'), false)
      assert.strictEqual(consumeMark({ started: [] }, client, 'search', '{"q":"x"}'), false)
      assert.strictEqual(consumeMark(trace, client, 'search', '{"q":"x"}'), true)
      // A mark is consumed once.
      assert.strictEqual(consumeMark(trace, client, 'search', '{"q":"x"}'), false)
      assert.strictEqual(consumeMark(trace, client, 'search', 'not json'), false)
    })

    it('matches a mark when validation changes the key order of the arguments', () => {
      const client = {}
      const listed = listTool(client, 'search')
      const { trace, interceptCtx } = outerTrace()
      const link = mustLink([
        { type: 'function', function: { name: 'search', parameters: listed.inputSchema } },
      ], chatFunction, interceptCtx)
      const args = '{"b":"1","a":{"y":[2,1],"x":null},"__proto__":{"e":1}}'
      const outputs = link.attach([{
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: args } }],
      }], anyToolCall)

      allow(link, outputs)

      // Another value, or another order of array items, does not match.
      const otherValue = '{"a":{"x":null,"y":[2,1]},"b":"2","__proto__":{"e":1}}'
      const otherArray = '{"a":{"x":null,"y":[1,2]},"b":"1","__proto__":{"e":1}}'
      const sameValues = '{"__proto__":{"e":1},"a":{"x":null,"y":[2,1]},"b":"1"}'
      assert.strictEqual(consumeMark(trace, client, 'search', otherValue), false)
      assert.strictEqual(consumeMark(trace, client, 'search', otherArray), false)
      assert.strictEqual(consumeMark(trace, client, 'search', sameValues), true)
    })

    it('keeps a bounded number of marks for each trace', () => {
      const client = {}
      const listed = listTool(client, 'search')
      const { trace, interceptCtx } = outerTrace()
      const link = mustLink([
        { type: 'function', function: { name: 'search', parameters: listed.inputSchema } },
      ], chatFunction, interceptCtx)
      const toolCalls = []
      for (let i = 0; i < 65; i++) {
        toolCalls.push({ id: `call_${i}`, function: { name: 'search', arguments: JSON.stringify({ q: i }) } })
      }
      const outputs = link.attach([{ role: 'assistant', tool_calls: toolCalls }], anyToolCall)

      allow(link, outputs)

      assert.strictEqual(consumeMark(trace, client, 'search', '{"q":0}'), false)
      assert.strictEqual(consumeMark(trace, client, 'search', '{"q":1}'), true)
      assert.strictEqual(consumeMark(trace, client, 'search', '{"q":64}'), true)
    })

    it('sends one entry for two clients that reach the same server', () => {
      const first = { name: 'search', inputSchema: { type: 'object' } }
      const second = { name: 'fetch', inputSchema: { type: 'object' } }
      const sameServer = createClientServer({ type: 'streamable_http', url: 'https://mcp.example.com/other' })
      recordListedTools({}, server, [first])
      recordListedTools({}, sameServer, [second])
      const { interceptCtx } = outerTrace()
      const link = mustLink([
        { type: 'function', function: { name: 'a_search', parameters: first.inputSchema } },
        { type: 'function', function: { name: 'b_fetch', parameters: second.inputSchema } },
      ], chatFunction, interceptCtx)

      const messages = link.attach([{
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', function: { name: 'a_search', arguments: '{}' } },
          { id: 'call_2', function: { name: 'b_fetch', arguments: '{}' } },
        ],
      }], anyToolCall)

      assert.notStrictEqual(sameServer, server)
      assert.deepStrictEqual(link.evaluation(messages)?.servers, [
        { ...server, tools: { a_search: 'search', b_fetch: 'fetch' } },
      ])
    })

    it('ignores listed tools without a server or a schema', () => {
      const schema = { type: 'object' }
      recordListedTools({}, undefined, [{ name: 'search', inputSchema: schema }])
      recordListedTools({}, server, [{ name: 'search' }, { inputSchema: {} }, null])

      const { interceptCtx } = outerTrace()
      const link = linkMcpTools([
        { type: 'function', function: { name: 'search', parameters: schema } },
        null,
        'not a tool',
      ], chatFunction, interceptCtx)

      assert.strictEqual(link, undefined)
    })

    it('keeps no client alive through the listed schemas and the marks', async function () {
      this.timeout(10000)
      const fixture = path.join(__dirname, 'fixtures/mcp-client-retention.js')

      const { stdout, stderr } = await exec(process.execPath, ['--expose-gc', fixture], { timeout: 7000 })

      assert.strictEqual(stdout, '')
      assert.strictEqual(stderr, '')
    })
  })
})
