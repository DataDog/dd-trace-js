'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const path = require('node:path')

const { channel } = require('dc-polyfill')

const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')

const callToolInterceptCh = channel('dd-trace:mcp:callTool:intercept')
const listToolsResultCh = channel('dd-trace:mcp:listTools:result')

/**
 * Loads the server classes of an MCP v1 SDK directory.
 *
 * @param {string} sdkDir
 */
function loadV1Servers (sdkDir) {
  const load = file => require(path.join(sdkDir, 'dist/cjs', file))
  return {
    sdkDir,
    McpServer: load('server/mcp.js').McpServer,
    SSEServerTransport: load('server/sse.js').SSEServerTransport,
    StreamableHTTPServerTransport: load('server/streamableHttp.js').StreamableHTTPServerTransport,
    z: require(require.resolve('zod', { paths: [sdkDir] })).z,
  }
}

/**
 * @param {string} entryPath The path of a file in the dist/cjs/client directory of an SDK.
 */
function sdkRoot (entryPath) {
  return path.resolve(path.dirname(entryPath), '..', '..', '..')
}

const SUITES = [
  {
    packageName: '@modelcontextprotocol/sdk',
    subModule: '@modelcontextprotocol/sdk/client',
    // Only MCP v1 has the MCP tracing plugin, and the client check of task-based tools.
    v1: true,
    load (meta) {
      const sdkDir = sdkRoot(meta.versionMod.getPath('@modelcontextprotocol/sdk/client'))
      const load = file => require(path.join(sdkDir, 'dist/cjs', file))
      return {
        ...loadV1Servers(sdkDir),
        Client: meta.mod.Client,
        InMemoryTransport: load('inMemory.js').InMemoryTransport,
        SSEClientTransport: load('client/sse.js').SSEClientTransport,
        StdioClientTransport: load('client/stdio.js').StdioClientTransport,
        StreamableHTTPClientTransport: load('client/streamableHttp.js').StreamableHTTPClientTransport,
      }
    },
  },
  {
    packageName: '@modelcontextprotocol/client',
    subModule: '@modelcontextprotocol/client',
    v1: false,
    // The MCP v2 client talks to the latest MCP v1 servers with the same protocol. The instrumentation
    // under test is only on the client side.
    load (meta) {
      const v1 = require('../../../versions/@modelcontextprotocol/sdk')
      return {
        ...loadV1Servers(sdkRoot(v1.getPath('@modelcontextprotocol/sdk/client'))),
        Client: meta.mod.Client,
        InMemoryTransport: meta.mod.InMemoryTransport,
        SSEClientTransport: meta.mod.SSEClientTransport,
        StdioClientTransport: meta.versionMod.get('@modelcontextprotocol/client/stdio').StdioClientTransport,
        StreamableHTTPClientTransport: meta.mod.StreamableHTTPClientTransport,
      }
    },
  },
]

// The instrumentation channels that AI Guard uses, with the real SDK classes of each tested version.
for (const suite of SUITES) {
  createIntegrationTestSuite('modelcontextprotocol-sdk', suite.packageName, {
    subModule: suite.subModule,
  }, (meta) => {
    const { agent } = meta
    let sdk
    let subscribers

    before(() => {
      sdk = suite.load(meta)
    })

    beforeEach(() => {
      subscribers = []
    })

    afterEach(() => {
      for (const [ch, subscriber] of subscribers) ch.unsubscribe(subscriber)
    })

    /**
     * @param {import('dc-polyfill').Channel} ch
     * @param {(ctx: object) => void} subscriber
     */
    function subscribe (ch, subscriber) {
      ch.subscribe(subscriber)
      subscribers.push([ch, subscriber])
    }

    /**
     * @param {string[]} calls The texts that the tool handler gets.
     */
    function createServer (calls) {
      const server = new sdk.McpServer({ name: 'test-server', version: '1.0.0' })
      server.registerTool('echo', { description: 'Echoes', inputSchema: { text: sdk.z.string() } }, ({ text }) => {
        calls.push(text)
        return { content: [{ type: 'text', text }] }
      })
      return server
    }

    describe('callTool intercept', () => {
      let calls
      let client
      let server

      beforeEach(async () => {
        calls = []
        server = createServer(calls)
        const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new sdk.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      afterEach(async () => {
        await client.close()
        await server.close()
      })

      it('calls the tool directly without subscribers', async () => {
        assert.strictEqual(callToolInterceptCh.hasSubscribers, false)

        const result = await client.callTool({ name: 'echo', arguments: { text: 'direct' } })

        assert.strictEqual(result.content[0].text, 'direct')
        assert.deepStrictEqual(calls, ['direct'])
      })

      it('publishes the client, its transport and the call arguments before the call', async () => {
        const published = []
        subscribe(callToolInterceptCh, ctx => published.push({ ...ctx, calls: [...calls] }))
        const params = { name: 'echo', arguments: { text: 'hello' } }

        await client.callTool(params)

        assert.strictEqual(published.length, 1)
        const [ctx] = published
        assert.strictEqual(ctx.client, client)
        assert.strictEqual(ctx.transport, client.transport)
        assert.deepStrictEqual(ctx.transportInfo, { type: 'in_process' })
        assert.strictEqual(ctx.arguments[0], params)
        assert.deepStrictEqual(ctx.calls, [])
        assert.deepStrictEqual(calls, ['hello'])
      })

      it('holds the call until the hook promise fulfils', async () => {
      /** @type {(value?: unknown) => void} */
        let release = () => {}
        subscribe(callToolInterceptCh, ctx => {
          if (ctx.arguments[0].arguments.text !== 'held') return
          ctx.beforeCall = () => new Promise(resolve => { release = resolve })
        })

        const held = client.callTool({ name: 'echo', arguments: { text: 'held' } })
        // The server handles the requests in order. A held call that was sent would run before this one.
        await client.callTool({ name: 'echo', arguments: { text: 'next' } })

        assert.deepStrictEqual(calls, ['next'])
        release()
        assert.strictEqual((await held).content[0].text, 'held')
        assert.deepStrictEqual(calls, ['next', 'held'])
      })

      it('never sends the call when the hook promise rejects', async () => {
        const error = new Error('blocked')
        subscribe(callToolInterceptCh, ctx => {
          if (ctx.arguments[0].arguments.text === 'blocked') ctx.beforeCall = () => Promise.reject(error)
        })

        await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'blocked' } }), candidate => {
          return candidate === error
        })
        // The server handles the requests in order. A blocked call that was sent would run before this one.
        await client.callTool({ name: 'echo', arguments: { text: 'next' } })

        assert.deepStrictEqual(calls, ['next'])
      })

      it('calls the original with the params that a subscriber puts in place', async () => {
      /** @type {(value?: unknown) => void} */
        let release = () => {}
        subscribe(callToolInterceptCh, ctx => {
          ctx.arguments[0] = structuredClone(ctx.arguments[0])
          ctx.beforeCall = () => new Promise(resolve => { release = resolve })
        })
        const params = { name: 'echo', arguments: { text: 'checked' } }

        const call = client.callTool(params)
        params.arguments.text = 'changed during the hold'
        release()

        assert.strictEqual((await call).content[0].text, 'checked')
        assert.deepStrictEqual(calls, ['checked'])
      })

      it('runs the call when the hook throws synchronously', async () => {
        subscribe(callToolInterceptCh, ctx => {
          ctx.beforeCall = () => { throw new Error('broken hook') }
        })

        const result = await client.callTool({ name: 'echo', arguments: { text: 'runs' } })

        assert.strictEqual(result.content[0].text, 'runs')
        assert.deepStrictEqual(calls, ['runs'])
      })

      if (suite.v1) {
        it('keeps the client span of an allowed call', async () => {
          subscribe(callToolInterceptCh, ctx => {
            ctx.beforeCall = () => Promise.resolve()
          })
          const span = expectSomeSpan(agent, { name: 'mcp.request', resource: 'client_tool_call' })

          await client.callTool({ name: 'echo', arguments: { text: 'traced' } })

          await span
        })
      }

      it('publishes no call of a client that is not connected or is closed', async () => {
        const published = []
        subscribe(callToolInterceptCh, ctx => published.push(ctx))
        const unconnected = new sdk.Client({ name: 'test-client', version: '1.0.0' })
        await client.close()

        await assert.rejects(unconnected.callTool({ name: 'echo', arguments: {} }), { message: 'Not connected' })
        await assert.rejects(client.callTool({ name: 'echo', arguments: {} }), { message: 'Not connected' })

        assert.strictEqual(published.length, 0)
      })

      if (suite.v1) {
        it('publishes no call of a tool that requires task-based execution', async () => {
          const published = []
          subscribe(callToolInterceptCh, ctx => published.push(ctx))
          const taskServer = new sdk.McpServer({ name: 'task-server', version: '1.0.0' }, {
            capabilities: { tasks: { requests: { tools: { call: {} } } } },
          })
          const unused = () => { throw new Error('not used') }
          taskServer.experimental.tasks.registerToolTask('task_tool', {
            description: 'Requires a task',
            inputSchema: { text: sdk.z.string() },
          }, { createTask: unused, getTask: unused, getTaskResult: unused })
          const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
          await taskServer.connect(serverTransport)
          const taskClient = new sdk.Client({ name: 'test-client', version: '1.0.0' })
          await taskClient.connect(clientTransport)
          await taskClient.listTools()

          try {
            await assert.rejects(taskClient.callTool({ name: 'task_tool', arguments: { text: 'x' } }), {
              name: 'McpError',
              message: /requires task-based execution/,
            })
            assert.strictEqual(published.length, 0)
          } finally {
            await taskClient.close()
            await taskServer.close()
          }
        })
      }

      it('publishes the listed tools before the caller gets them', async () => {
        const published = []
        subscribe(listToolsResultCh, ctx => published.push(ctx))

        const result = await client.listTools()

        assert.strictEqual(published.length, 1)
        assert.strictEqual(published[0].client, client)
        assert.strictEqual(published[0].transport, client.transport)
        assert.deepStrictEqual(published[0].transportInfo, { type: 'in_process' })
        assert.strictEqual(published[0].tools, result.tools)
        assert.strictEqual(published[0].tools[0].inputSchema, result.tools[0].inputSchema)
      })
    })

    describe('transport values', () => {
      let client
      let servers

      beforeEach(() => {
        servers = []
      })

      afterEach(async () => {
        await client?.close()
        for (const server of servers) server.close()
        client = undefined
      })

      /**
       * Returns the transport values that the instrumentation publishes for a call over the transport.
       *
       * @param {object} transport
       */
      async function publishedTransportInfo (transport) {
      /** @type {{ type: string, command?: unknown, args?: unknown, url?: URL }|undefined} */
        let info
        subscribe(callToolInterceptCh, ctx => { info = ctx.transportInfo })
        client = new sdk.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(transport)

        const result = await client.callTool({ name: 'echo', arguments: { text: 'remote' } })

        assert.strictEqual(result.content[0].text, 'remote')
        assert.ok(info)
        return info
      }

      /**
       * @param {http.RequestListener} handler
       */
      function listen (handler) {
        const server = http.createServer(handler)
        servers.push(server)
        server.listen(0, '127.0.0.1')
        return once(server, 'listening').then(() => {
          return /** @type {import('node:net').AddressInfo} */ (server.address()).port
        })
      }

      it('reads the command and the raw arguments of a stdio transport', async () => {
        const args = [path.join(__dirname, 'stdio-server.js'), '--token', 'raw']
        const transport = new sdk.StdioClientTransport({
          command: process.execPath,
          args,
          env: { MCP_SDK_DIR: sdk.sdkDir, SECRET: 'not read' },
        })

        const info = await publishedTransportInfo(transport)

        assert.deepStrictEqual(info, { type: 'stdio', command: process.execPath, args })
      })

      it('reads the URL of a streamable HTTP transport', async () => {
        const port = await listen(async (req, res) => {
          const server = createServer([])
          const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
          res.on('close', () => server.close())
          await server.connect(transport)
          await transport.handleRequest(req, res)
        })
        const url = new URL(`http://127.0.0.1:${port}/mcp?token=raw`)

        const info = await publishedTransportInfo(new sdk.StreamableHTTPClientTransport(url))

        assert.strictEqual(info.type, 'streamable_http')
        assert.strictEqual(info.url?.href, url.href)
      })

      it('reads the URL of an SSE transport', async () => {
        const transports = new Map()
        const port = await listen(async (req, res) => {
          if (req.method === 'GET') {
            const transport = new sdk.SSEServerTransport('/messages', res)
            transports.set(transport.sessionId, transport)
            await createServer([]).connect(transport)
          } else {
            const sessionId = new URL(String(req.url), 'http://127.0.0.1').searchParams.get('sessionId')
            await transports.get(sessionId).handlePostMessage(req, res)
          }
        })
        const url = new URL(`http://127.0.0.1:${port}/sse?token=raw`)

        const info = await publishedTransportInfo(new sdk.SSEClientTransport(url))

        assert.strictEqual(info.type, 'sse')
        assert.strictEqual(info.url?.href, url.href)
      })
    })
  })
}
