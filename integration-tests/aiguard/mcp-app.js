'use strict'

require('dd-trace').init({ flushInterval: 0 })

const fs = require('node:fs')
const path = require('node:path')

const v2 = require('@modelcontextprotocol/client')
const { StdioClientTransport: StdioClientTransportV2 } = require('@modelcontextprotocol/client/stdio')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { McpServer: McpServerV2 } = require('@modelcontextprotocol/server')
const { Agent, MCPServerStdio, MCPServerStreamableHttp, OpenAIChatCompletionsModel, run } = require('@openai/agents')
const express = require('express')
const OpenAI = require('openai')
const { z } = require('zod')

// Every value that AI Guard must never receive contains this marker.
const SECRET = 'SECRET-VALUE'
const SIDE_EFFECT_FILE = process.env.MCP_SIDE_EFFECT_FILE
const STDIO_SERVER = path.join(__dirname, 'mcp-stdio-server.js')

// A fake npx on the PATH of the stdio child, so the test sends the real `npx -y <package>` shape.
// It lives in the sandbox, which the test harness removes.
const npxDir = path.join(__dirname, 'npx-bin')
fs.mkdirSync(npxDir, { recursive: true })
fs.writeFileSync(path.join(npxDir, 'npx'), `#!/usr/bin/env node\nrequire(${JSON.stringify(STDIO_SERVER)})\n`)
fs.chmodSync(path.join(npxDir, 'npx'), 0o755)

const openai = new OpenAI({ apiKey: 'test-key', baseURL: process.env.OPENAI_BASE_URL })
const inProcessEffects = []
const delayedOutcomes = []

/**
 * Describes the value that a tool handler gets, so a test can see its type on the server side.
 *
 * @param {unknown} value
 */
function describeValue (value) {
  if (value instanceof Date) return 'Date'
  if (typeof value === 'bigint') return 'BigInt'
  if (value !== null && typeof value === 'object' && value.self === value) return 'cycle'
  return JSON.stringify(value)
}

/**
 * @param {string} label
 * @param {string} text
 */
function writeLine (label, text) {
  inProcessEffects.push(`${label}:${text}`)
  return { content: [{ type: 'text', text: `wrote ${text}` }] }
}

/**
 * @param {string} label
 * @param {unknown} value
 */
function recordValue (label, value) {
  const description = describeValue(value)
  inProcessEffects.push(`${label}:record:${description}`)
  return { content: [{ type: 'text', text: description }] }
}

/**
 * @param {string} label
 */
function createMcpServer (label) {
  const server = new McpServer({ name: `${label}-handshake-name`, version: '1.0.0' })
  server.registerTool('write_file', {
    description: 'Writes a line',
    inputSchema: { text: z.string() },
  }, ({ text }) => writeLine(label, text))
  server.registerTool('record_value', {
    description: 'Records the type of a value',
    inputSchema: { value: z.any(), text: z.string().optional() },
  }, ({ value }) => recordValue(label, value))
  return server
}

/**
 * An MCP v2 server, for the in-memory pair of MCP v2.
 *
 * @param {string} label
 */
function createMcpServerV2 (label) {
  const server = new McpServerV2({ name: `${label}-handshake-name`, version: '1.0.0' })
  server.registerTool('write_file', {
    description: 'Writes a line',
    inputSchema: z.object({ text: z.string() }),
  }, ({ text }) => writeLine(label, text))
  server.registerTool('record_value', {
    description: 'Records the type of a value',
    inputSchema: z.object({ value: z.any(), text: z.string().optional() }),
  }, ({ value }) => recordValue(label, value))
  return server
}

// The MCP v2 clients talk to the same MCP v1 servers over stdio, streamable HTTP and SSE, because the
// protocol is the same and the instrumentation is only on the client side. The in-memory pair of
// MCP v2 has an MCP v2 server, so both ends are MCP v2.
const SDKS = {
  v1: {
    Client,
    InMemoryTransport,
    SSEClientTransport,
    StdioClientTransport,
    StreamableHTTPClientTransport,
    createInMemoryServer: createMcpServer,
  },
  v2: {
    Client: v2.Client,
    InMemoryTransport: v2.InMemoryTransport,
    SSEClientTransport: v2.SSEClientTransport,
    StdioClientTransport: StdioClientTransportV2,
    StreamableHTTPClientTransport: v2.StreamableHTTPClientTransport,
    createInMemoryServer: createMcpServerV2,
  },
}

// The remote MCP servers listen on their own port.
const mcpApp = express()
mcpApp.use(express.json())
mcpApp.post('/mcp/:token', async (req, res) => {
  const server = createMcpServer('streamable_http')
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})
mcpApp.all('/mcp/:token', (req, res) => res.status(405).end())

const sseTransports = new Map()
mcpApp.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res)
  sseTransports.set(transport.sessionId, transport)
  res.on('close', () => sseTransports.delete(transport.sessionId))
  await createMcpServer('sse').connect(transport)
})
mcpApp.post('/messages', async (req, res) => {
  const transport = sseTransports.get(req.query.sessionId)
  if (!transport) return res.status(404).end()
  await transport.handlePostMessage(req, res, req.body)
})

const mcpListener = mcpApp.listen(0, '127.0.0.1')

/**
 * The URL of the streamable HTTP server. Its path, query and fragment hold secrets.
 */
function streamableHttpUrl () {
  const { port } = /** @type {import('net').AddressInfo} */ (mcpListener.address())
  return new URL(`http://127.0.0.1:${port}/mcp/${SECRET}?token=${SECRET}#${SECRET}`)
}

/**
 * @param {string} kind
 * @param {keyof SDKS} sdkName
 */
function createTransport (kind, sdkName) {
  const sdk = SDKS[sdkName]
  const { port } = /** @type {import('net').AddressInfo} */ (mcpListener.address())
  const env = { MCP_SIDE_EFFECT_FILE: SIDE_EFFECT_FILE, SECRET_ENV: SECRET }
  const requestInit = { headers: { Authorization: `Bearer ${SECRET}` } }

  switch (kind) {
    case 'stdio':
      return new sdk.StdioClientTransport({
        command: process.execPath,
        args: [STDIO_SERVER, '--api-key', SECRET],
        env,
        cwd: __dirname,
      })
    case 'npx':
      return new sdk.StdioClientTransport({
        command: 'npx',
        args: ['-y', '@scope/pkg@1.2.3', '--api-key', SECRET],
        // The fake npx runs with the node binary of this process.
        env: { ...env, PATH: [npxDir, path.dirname(process.execPath)].join(path.delimiter) },
      })
    case 'streamable_http':
      return new sdk.StreamableHTTPClientTransport(streamableHttpUrl(), { requestInit })
    case 'sse':
      return new sdk.SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse?token=${SECRET}`), { requestInit })
    case 'in_memory': {
      const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
      sdk.createInMemoryServer('in_memory').connect(serverTransport)
      return clientTransport
    }
    default:
      throw new Error(`Unknown transport ${kind}`)
  }
}

const clients = new Map()

/**
 * Returns a connected client for the transport kind. The tests reuse one client for each kind.
 *
 * @param {string} kind
 * @param {keyof SDKS} sdkName
 */
function connect (kind, sdkName) {
  const key = `${sdkName}:${kind}`
  let client = clients.get(key)
  if (!client) {
    const created = new SDKS[sdkName].Client({ name: `app-client-${SECRET}`, version: '1.0.0' })
    client = created.connect(createTransport(kind, sdkName)).then(() => created)
    clients.set(key, client)
  }
  return client
}

/**
 * @param {import('express').Request} req
 * @returns {keyof SDKS}
 */
function sdkOf (req) {
  return req.query.sdk === 'v2' ? 'v2' : 'v1'
}

/**
 * Returns call arguments with a value that JSON cannot carry as it is, or null arguments.
 *
 * @param {string} kind
 * @param {unknown} text
 */
function createArguments (kind, text) {
  if (kind === 'null') return null

  const args = text === undefined ? {} : { text: String(text) }
  switch (kind) {
    case 'date':
      args.value = new Date(0)
      break
    case 'bigint':
      args.value = 7n
      break
    case 'cycle': {
      const value = { name: 'loop' }
      value.self = value
      args.value = value
      break
    }
    default:
      throw new Error(`Unknown value ${kind}`)
  }
  return args
}

/**
 * @param {import('express').Response} res
 * @param {Error|undefined} error
 */
function sendError (res, error) {
  if (error?.name === 'AIGuardAbortError') {
    res.status(403).json({ blocked: true, reason: error.reason })
  } else {
    res.status(500).json({ error: error?.message })
  }
}

const app = express()

app.get('/mcp/connect', async (req, res) => {
  try {
    const client = await connect(String(req.query.transport), sdkOf(req))
    const { tools } = await client.listTools()
    res.json({ tools: tools.map(tool => tool.name) })
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/mcp/call', async (req, res) => {
  try {
    const client = await connect(String(req.query.transport), sdkOf(req))
    const result = await client.callTool({ name: 'write_file', arguments: { text: String(req.query.text) } })
    res.json({ blocked: false, result: result.content[0].text })
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/mcp/value', async (req, res) => {
  try {
    const client = await connect(String(req.query.transport), sdkOf(req))
    const args = createArguments(String(req.query.value), req.query.text)
    const result = await client.callTool({ name: 'record_value', arguments: args })
    res.json({ blocked: false, isError: result.isError === true, result: result.content[0].text })
  } catch (error) {
    sendError(res, error)
  }
})

// The application reuses one params object and changes it while the calls wait for their checks.
app.get('/mcp/reuse', async (req, res) => {
  try {
    const client = await connect(String(req.query.transport), sdkOf(req))
    const params = { name: 'write_file', arguments: { text: '' } }
    const calls = []
    for (const text of ['first', 'second', 'third']) {
      params.arguments.text = text
      calls.push(client.callTool(params))
    }
    params.name = 'missing_tool'
    params.arguments = { text: 'changed after the calls' }
    const results = await Promise.all(calls)
    res.json({ results: results.map(result => result.content[0].text) })
  } catch (error) {
    sendError(res, error)
  }
})

// The SDK rejects the call of a client that is not connected, before it sends anything.
app.get('/mcp/unconnected', async (req, res) => {
  try {
    const client = new SDKS[sdkOf(req)].Client({ name: `app-client-${SECRET}`, version: '1.0.0' })
    await client.callTool({ name: 'write_file' })
    res.json({ called: true })
  } catch (error) {
    sendError(res, error)
  }
})

// The call runs after the response, outside the request handler.
app.get('/mcp/delayed', async (req, res) => {
  const client = await connect(String(req.query.transport), sdkOf(req))
  const text = String(req.query.text)
  res.status(202).json({ scheduled: true })
  setTimeout(() => {
    client.callTool({ name: 'write_file', arguments: { text } }).then(
      () => delayedOutcomes.push({ text, outcome: 'allowed' }),
      error => delayedOutcomes.push({ text, outcome: error.name })
    )
  }, 50)
})

// The model gets the listed schema object, so AI Guard links the model tool call to the MCP server.
app.get('/mcp/openai', async (req, res) => {
  try {
    const client = await connect('streamable_http', sdkOf(req))
    const { tools } = await client.listTools()
    const tool = tools.find(candidate => candidate.name === 'write_file')
    const parameters = req.query.clone === 'true' ? structuredClone(tool.inputSchema) : tool.inputSchema
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `CALL ${JSON.stringify({ text: String(req.query.text) })}` }],
      tools: [{
        type: 'function',
        function: { name: `${req.query.prefix ?? ''}${tool.name}`, description: tool.description, parameters },
      }],
    })
    const toolCall = completion.choices[0].message.tool_calls[0]
    const params = { name: tool.name, arguments: JSON.parse(toolCall.function.arguments) }
    const call = client.callTool(params)
    // The application changes the params after the call starts. The server must get the checked values.
    if (req.query.mutate === 'true') params.arguments.text = 'changed after the call'
    const result = await call
    res.json({ blocked: false, toolCallId: toolCall.id, result: result.content[0].text })
  } catch (error) {
    sendError(res, error)
  }
})

/**
 * Returns the MCP server object of OpenAI Agents for the transport kind.
 *
 * @param {string} kind
 * @param {string|undefined} name Without a name, OpenAI Agents makes one from the command or the URL.
 */
function createAgentsServer (kind, name) {
  if (kind === 'streamable_http') {
    return new MCPServerStreamableHttp({
      name,
      url: streamableHttpUrl().href,
      requestInit: { headers: { Authorization: `Bearer ${SECRET}` } },
    })
  }
  return new MCPServerStdio({
    name,
    command: process.execPath,
    args: [STDIO_SERVER, '--api-key', SECRET],
    env: { MCP_SIDE_EFFECT_FILE: SIDE_EFFECT_FILE, SECRET_ENV: SECRET },
  })
}

app.get('/mcp/agents', async (req, res) => {
  const transport = String(req.query.transport ?? 'stdio')
  const server = createAgentsServer(transport, req.query.named === 'false' ? undefined : 'local-files')
  try {
    await server.connect()
    const agent = new Agent({
      name: 'writer',
      instructions: 'Write the line with the tool.',
      model: new OpenAIChatCompletionsModel(openai, 'gpt-4o-mini'),
      mcpServers: [server],
    })
    const result = await run(agent, `CALL ${JSON.stringify({ text: String(req.query.text) })}`)
    // The tool results that the agent gave the model, also for a blocked tool call.
    const toolOutputs = result.newItems
      .filter(item => item.type === 'tool_call_output_item')
      .map(item => item.output)
    // A direct call of the application after the run. It must not get the name of the agent server.
    if (req.query.direct === 'true') {
      const client = await connect(transport, 'v1')
      await client.callTool({ name: 'write_file', arguments: { text: 'direct' } })
    }
    res.json({ output: result.finalOutput, toolOutputs })
  } catch (error) {
    sendError(res, error)
  } finally {
    await server.close()
  }
})

app.get('/mcp/state', (req, res) => {
  const stdio = fs.existsSync(SIDE_EFFECT_FILE) ? fs.readFileSync(SIDE_EFFECT_FILE, 'utf8').split('\n') : []
  res.json({ inProcess: inProcessEffects, stdio: stdio.filter(Boolean), delayed: delayedOutcomes })
})

mcpListener.once('listening', () => {
  const server = app.listen(() => {
    const { port } = /** @type {import('net').AddressInfo} */ (server.address())
    process.send({ port })
  })
})
