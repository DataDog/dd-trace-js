'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const execFileAsync = promisify(execFile)
const python = process.env.MCP_PYTHON || ''
const pythonPeer = path.join(__dirname, 'integration-test/peer.py')
const nodePeer = path.join(__dirname, 'integration-test/stdio-server.js')
const itWithPython = python ? it : it.skip

describe('MCP Python interoperability', () => {
  withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', version => {
    let peerEnv

    before(async () => {
      if (!python) return
      await agent.load('modelcontextprotocol-sdk')
      peerEnv = {
        ...process.env,
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_TRACE_API_VERSION: 'v0.4',
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_TRACE_DEBUG: 'false',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_REMOTE_CONFIGURATION_ENABLED: 'false',
        DD_MCP_DISTRIBUTED_TRACING: 'true',
      }
    })

    after(async () => {
      if (python) await agent.close()
    })

    itWithPython('parents a Python server span to the JavaScript client span over stdio', async () => {
      const versionMod = require(`../../../versions/@modelcontextprotocol/sdk@${version}`)
      const { Client } = versionMod.get('@modelcontextprotocol/sdk/client')
      const { StdioClientTransport } = versionMod.get('@modelcontextprotocol/sdk/client/stdio.js')
      const client = new Client({ name: 'node-client', version: '1.0.0' })
      const transport = new StdioClientTransport({ command: python, args: [pythonPeer, 'server'], env: peerEnv })
      try {
        await client.connect(transport)
        const clientSpans = []
        const traceAssertion = agent.assertSomeTraces(traces => {
          const clientSpan = traces.flat().find(span => span.resource === 'client_tool_call')
          assert.ok(clientSpan)
          clientSpans.push(clientSpan)
        })
        const [result] = await Promise.all([
          client.callTool({ name: 'trace_context', arguments: {} }),
          traceAssertion,
        ])
        assert.strictEqual(result.isError, false)
        const [clientSpan] = clientSpans
        const response = JSON.parse(result.content[0].text)
        assert.strictEqual(response.parent_id, clientSpan.span_id.toString())
        const low = BigInt(clientSpan.trace_id.toString()).toString(16).padStart(16, '0')
        assert.strictEqual(response.trace_id, `${clientSpan.meta['_dd.p.tid']}${low}`)
      } finally {
        await client.close()
      }
    })

    itWithPython('parents the JavaScript server span to a Python client span over stdio', async () => {
      const spans = []
      const capture = traces => spans.push(...traces.flat())
      agent.subscribe(capture)
      try {
        const { stdout } = await execFileAsync(python, [pythonPeer, 'client', process.execPath, nodePeer, version], {
          env: peerEnv,
          timeout: 15000,
        })
        const response = JSON.parse(stdout)
        const serverSpan = spans.find(span => span.resource === 'server_tool_call')
        assert.ok(serverSpan)
        assert.strictEqual(serverSpan.parent_id.toString(), response.response.headers['x-datadog-parent-id'])
        const low = BigInt(serverSpan.trace_id.toString()).toString(16).padStart(16, '0')
        assert.strictEqual(`${serverSpan.meta['_dd.p.tid']}${low}`, response.trace_id)
        assert.strictEqual(response.response.trace_id, response.trace_id)
      } finally {
        agent.unsubscribe(capture)
      }
    })
  })
})
