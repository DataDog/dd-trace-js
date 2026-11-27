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
const PEER_TIMEOUT_MS = 15000

describe('MCP Python interoperability', function () {
  // Leave time for trace delivery and cleanup after the peer's own deadline.
  this.timeout(PEER_TIMEOUT_MS + 2000)

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
      const signal = AbortSignal.timeout(PEER_TIMEOUT_MS)
      try {
        await client.connect(transport, { signal })
        const tracer = require('../../dd-trace')
        let clientParentId
        let traceId
        let clientSpan
        let result
        await agent.assertSomeTraces(traces => {
          clientSpan = traces.flat().find(span =>
            span.resource === 'client_tool_call' && span.parent_id.toString() === clientParentId
          )
          assert.ok(clientSpan)
        }, {
          async operation () {
            result = await tracer.trace('interop.client', parent => {
              const context = parent.context()
              clientParentId = context.toSpanId()
              traceId = context.toTraceparent().split('-')[1]
              return client.callTool({ name: 'trace_context', arguments: {} }, undefined, { signal })
            })
          },
        })
        assert.strictEqual(result.isError, false)
        const response = JSON.parse(result.content[0].text)
        assert.strictEqual(response.parent_id, clientSpan.span_id.toString())
        assert.strictEqual(response.trace_id, traceId)
      } finally {
        await client.close()
      }
    })

    itWithPython('parents the JavaScript server span to a Python client span over stdio', async () => {
      const service = 'mcp-interop-node-server'
      let serverSpan
      let stdout
      await agent.assertSomeTraces(traces => {
        serverSpan = traces.flat().find(span => span.service === service && span.resource === 'server_tool_call')
        assert.ok(serverSpan)
      }, {
        async operation () {
          const result = await execFileAsync(python, [pythonPeer, 'client', process.execPath, nodePeer, version], {
            env: { ...peerEnv, DD_SERVICE: service },
            timeout: PEER_TIMEOUT_MS,
          })
          stdout = result.stdout
        },
      })
      const response = JSON.parse(stdout)
      assert.strictEqual(serverSpan.parent_id.toString(), response.response.headers['x-datadog-parent-id'])
      const low = BigInt(serverSpan.trace_id.toString()).toString(16).padStart(16, '0')
      assert.strictEqual(`${serverSpan.meta['_dd.p.tid']}${low}`, response.trace_id)
      assert.strictEqual(response.response.trace_id, response.trace_id)
    })
  })
})
