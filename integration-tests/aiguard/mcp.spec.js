'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { BlockList } = require('node:net')
const path = require('node:path')
const { inspect } = require('node:util')

const msgpack = require('@msgpack/msgpack')
const { after, before, beforeEach, describe, it } = require('mocha')

const { spawnProcAndExpectExit } = require('../helpers')
const { LOCAL_ORIGIN, expectedServer, itChecksAgentsMcpToolCalls, serverId, useMcpApp } = require('./mcp-helpers')

const SDKS = ['v1', 'v2']

/**
 * The BlockList of the blocklist kind of mcp-app.js, as the check reads it.
 */
function checkedBlockList () {
  const list = new BlockList()
  list.addAddress('10.0.0.1')
  return list
}

/**
 * @param {object} evaluation
 */
function toolArguments (evaluation) {
  return evaluation.messages[0].tool_calls[0].function.arguments
}

describe('AIGuard MCP client tool calls', () => {
  // The MCP v2 client talks to the MCP v1 servers of mcp-app.js. MCP v2 is also the server of the
  // MCP v2 in-memory pair.
  const harness = useMcpApp([
    'express',
    '@modelcontextprotocol/sdk@1.32.2',
    '@modelcontextprotocol/client@2.4.0',
    '@modelcontextprotocol/server@2.4.0',
    'openai@6',
    '@openai/agents@0.14.3',
    'zod',
  ])
  const { attributes, assertDirectCall, assertNoSecrets, directCalls, effects, get, mcpEvaluations, state } = harness

  describe('direct calls', () => {
    beforeEach(harness.startApp)

    for (const sdk of SDKS) {
      for (const transport of ['stdio', 'streamable_http', 'sse']) {
        it(`enforces the decision before a ${transport} server runs the tool (${sdk})`, async () => {
          const call = text => get(`/mcp/call?sdk=${sdk}&transport=${transport}&text=${encodeURIComponent(text)}`)
          const allowed = await call('allowed')
          const blocked = await call('bad [deny]')
          const monitored = await call('seen [monitor]')

          assert.strictEqual(allowed.status, 200)
          assert.strictEqual(blocked.status, 403)
          assert.strictEqual(monitored.status, 200)
          assert.deepStrictEqual(await effects(transport), [`${transport}:allowed`, `${transport}:seen [monitor]`])

          // One evaluation for each call, and no evaluation for the connection or the tool list.
          const evaluations = attributes()
          assert.strictEqual(evaluations.length, 3)
          const servers = evaluations.map((evaluation, index) => {
            return assertDirectCall(evaluation, ['allowed', 'bad [deny]', 'seen [monitor]'][index])
          })
          assert.deepStrictEqual(servers[1], servers[0])
          assert.deepStrictEqual(servers[2], servers[0])
          assert.deepStrictEqual(servers[0], expectedServer(transport, servers[0]))
          assertNoSecrets()
        })
      }

      it(`evaluates an in-process server as an ordinary tool call and still enforces it (${sdk})`, async () => {
        const allowed = await get(`/mcp/call?sdk=${sdk}&transport=in_memory&text=allowed`)
        const blocked = await get(`/mcp/call?sdk=${sdk}&transport=in_memory&text=${encodeURIComponent('bad [deny]')}`)

        assert.strictEqual(allowed.status, 200)
        assert.strictEqual(blocked.status, 403)
        assert.deepStrictEqual((await state()).inProcess, ['in_memory:allowed'])
        const evaluations = attributes()
        assert.strictEqual(evaluations.length, 2)
        for (const evaluation of evaluations) {
          assert.ok(!Object.hasOwn(evaluation, 'mcp_servers'))
          assert.deepStrictEqual(Object.keys(evaluation.messages[0].tool_calls[0]), ['id', 'function'])
        }
      })

      for (const transport of ['in_memory', 'stdio']) {
        it(`sends the checked values when the application changes the params in the check (${transport}, ${sdk})`,
          async () => {
            const response = await get(`/mcp/reuse?sdk=${sdk}&transport=${transport}`)

            assert.strictEqual(response.status, 200)
            assert.deepStrictEqual(response.body.results, ['wrote first', 'wrote second', 'wrote third'])
            const expected = [`${transport}:first`, `${transport}:second`, `${transport}:third`]
            assert.deepStrictEqual([...await effects(transport)].sort(), expected)
            const checked = attributes().map(evaluation => JSON.parse(toolArguments(evaluation)).text)
            assert.deepStrictEqual(checked.sort(), ['first', 'second', 'third'])
          })
      }

      it(`makes no evaluation for a client that is not connected (${sdk})`, async () => {
        const response = await get(`/mcp/unconnected?sdk=${sdk}`)

        assert.strictEqual(response.status, 500)
        assert.match(response.body, /Not connected/)
        assert.strictEqual(attributes().length, 0)
      })
    }

    it('sends only the package of an npx command', async () => {
      const response = await get('/mcp/call?transport=npx&text=pkg')

      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual((await state()).stdio, ['stdio:pkg'])
      const [evaluation] = attributes()
      assert.deepStrictEqual(assertDirectCall(evaluation, 'pkg'), {
        id: serverId('stdio|npx|@scope/pkg@1.2.3'),
        managed_by: 'client',
        transport: 'stdio',
        command: 'npx',
        args: ['@scope/pkg@1.2.3'],
        tools: { write_file: 'write_file' },
      })
      assertNoSecrets()
    })

    it('keeps the server of each client when two clients expose the same tool', async () => {
      await get('/mcp/call?transport=stdio&text=one')
      await get('/mcp/call?sdk=v2&transport=sse&text=two')

      const [first, second] = attributes()
      assert.strictEqual(assertDirectCall(first, 'one').transport, 'stdio')
      assert.strictEqual(assertDirectCall(second, 'two').transport, 'sse')
      assert.notStrictEqual(first.mcp_servers[0].id, second.mcp_servers[0].id)
    })

    it('keeps the MCP span of an allowed call and creates none for a blocked call', async () => {
      // The stdio server process runs for the whole test, so its span keeps the connect trace open.
      await get('/mcp/connect?transport=stdio')
      const spans = []
      const traces = harness.agent.assertMessageReceived(({ payload }) => {
        spans.push(...payload.flat())
        const blocked = spans.find(span => span.name === 'ai_guard' && span.meta['ai_guard.blocked'] === 'true')
        const allowed = spans.find(span => span.name === 'ai_guard' && span.meta['ai_guard.action'] === 'ALLOW')
        assert.ok(blocked && allowed)
        const requests = spans.filter(span => span.name === 'express.request')
        assert.ok(requests.some(span => span.trace_id === blocked.trace_id))
        assert.ok(requests.some(span => span.trace_id === allowed.trace_id))
      }, 20_000)

      await get('/mcp/call?transport=stdio&text=allowed')
      await get(`/mcp/call?transport=stdio&text=${encodeURIComponent('bad [deny]')}`)
      await traces

      const toolCallSpans = trace => spans.filter(span => {
        return span.trace_id === trace && span.name === 'mcp.request' && span.resource === 'client_tool_call'
      })
      const blocked = spans.find(span => span.name === 'ai_guard' && span.meta['ai_guard.blocked'] === 'true')
      const allowed = spans.find(span => span.name === 'ai_guard' && span.meta['ai_guard.action'] === 'ALLOW')
      assert.strictEqual(toolCallSpans(blocked.trace_id).length, 0)
      assert.strictEqual(toolCallSpans(allowed.trace_id).length, 1)
      assert.strictEqual(blocked.meta['ai_guard.target'], 'tool')
      assert.strictEqual(blocked.meta['ai_guard.tool_name'], 'write_file')

      // The meta-struct reports the sent servers and keeps the mcp reference of the tool call.
      const [allowedRequest, blockedRequest] = attributes()
      const metaStruct = msgpack.decode(blocked.meta_struct.ai_guard)
      assert.deepStrictEqual(metaStruct.mcp_servers, blockedRequest.mcp_servers)
      assert.deepStrictEqual(metaStruct.messages, blockedRequest.messages)
      assert.deepStrictEqual(msgpack.decode(allowed.meta_struct.ai_guard).mcp_servers, allowedRequest.mcp_servers)
    })

    for (const [text, outcome, expected] of [
      ['later', 'allowed', ['stdio:later']],
      ['later [deny]', 'AIGuardAbortError', []],
    ]) {
      it(`checks a call that runs after the response (${outcome})`, async () => {
        const response = await get(`/mcp/delayed?transport=stdio&text=${encodeURIComponent(text)}`)
        assert.strictEqual(response.status, 202)

        let current = await state()
        for (let attempt = 0; current.delayed.length === 0 && attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50))
          current = await state()
        }

        assert.deepStrictEqual(current.delayed, [{ text, outcome }])
        assert.deepStrictEqual(current.stdio, expected)
        assert.strictEqual(mcpEvaluations().length, 1)
        assertDirectCall(mcpEvaluations()[0], text)
      })
    }
  })

  // A JSON transport sends the JSON form of the arguments. An in-process server gets the objects.
  describe('arguments that the server gets', () => {
    beforeEach(harness.startApp)

    for (const sdk of SDKS) {
      /**
       * @param {string} transport
       * @param {string} value
       * @param {string} [text]
       */
      const callValue = (transport, value, text) => {
        const query = text === undefined ? '' : `&text=${encodeURIComponent(text)}`
        return get(`/mcp/value?sdk=${sdk}&transport=${transport}&value=${value}${query}`)
      }

      it(`gives an in-process server the Date of the application (${sdk})`, async () => {
        const response = await callValue('in_memory', 'date')

        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.body.result, 'Date')
        assert.deepStrictEqual((await state()).inProcess, ['in_memory:record:Date'])
        assert.deepStrictEqual(attributes().map(toolArguments), ['{"value":"1970-01-01T00:00:00.000Z"}'])
      })

      for (const [value, evaluated, received] of [
        ['bigint', '"7"', 'BigInt'],
        ['cycle', '{"name":"loop","self":"[Circular]"}', 'cycle'],
      ]) {
        it(`evaluates a ${value} for an in-process server and blocks it on a deny (${sdk})`, async () => {
          const allowed = await callValue('in_memory', value)
          const blocked = await callValue('in_memory', value, 'bad [deny]')

          assert.strictEqual(allowed.status, 200)
          assert.strictEqual(allowed.body.result, received)
          assert.strictEqual(blocked.status, 403)
          assert.deepStrictEqual((await state()).inProcess, [`in_memory:record:${received}`])
          assert.deepStrictEqual(attributes().map(toolArguments), [
            `{"value":${evaluated}}`,
            `{"text":"bad [deny]","value":${evaluated}}`,
          ])
        })
      }

      it(`evaluates a BigInt over stdio, and the SDK still rejects the call that it allows (${sdk})`, async () => {
        const allowed = await callValue('stdio', 'bigint')
        const blocked = await callValue('stdio', 'bigint', 'bad [deny]')

        assert.strictEqual(allowed.status, 500)
        assert.match(allowed.body, /serialize a BigInt/)
        assert.strictEqual(blocked.status, 403)
        assert.deepStrictEqual((await state()).stdio, [])
        const evaluated = mcpEvaluations().map(toolArguments)
        assert.deepStrictEqual(evaluated, ['{"value":"7"}', '{"text":"bad [deny]","value":"7"}'])
      })

      it(`sends the checked snapshot when the application changes a value in the check (${sdk})`, async () => {
        for (const [kind, checked, evaluated] of [
          ['date', inspect(new Date(0)), '"1970-01-01T00:00:00.000Z"'],
          // The structured clone of a Buffer is a Uint8Array with the same bytes.
          ['buffer', inspect(new Uint8Array([97, 98, 99])), '[97,98,99]'],
          ['uint8array', inspect(new Uint8Array([1, 2, 3])), '[1,2,3]'],
          ['arraybuffer', inspect(new Uint8Array([4, 5]).buffer), '[4,5]'],
          ['map', inspect(new Map([['a', 1], ['b', 2]])), '[["a",1],["b",2]]'],
          ['set', inspect(new Set([1])), '[1]'],
          ['nested', inspect({ inner: { list: [1] } }), '{"inner":{"list":[1]}}'],
          ['regexp', inspect(/a+/g), '"/a+/g"'],
          ['error', 'TypeError: boom', '{"name":"TypeError","message":"boom","stack":"TypeError: boom"}'],
          ['bigint', inspect({ count: 7n }), '{"count":"7"}'],
          // A class instance is a plain object, and a subclass is its built-in object.
          ['instance', inspect({ x: 1 }), '{"x":1}'],
          ['datesub', inspect(new Date(0)), '"1970-01-01T00:00:00.000Z"'],
          ['mapsub', inspect(new Map([['a', 1]])), '[["a",1]]'],
          // These values have no structured clone that the server can get, so the server gets the
          // JSON form, as on the wire.
          ['shared', inspect({ 0: 1, 1: 0 }), '{"0":1,"1":0}'],
          ['blob', inspect({}), '{}'],
          ['blocklist', inspect(JSON.parse(JSON.stringify(checkedBlockList()))), JSON.stringify(checkedBlockList())],
          ['proxy', inspect({ a: 1 }), '{"a":1}'],
          ['function', inspect({ a: 1 }), '{"a":1}'],
        ]) {
          const response = await get(`/mcp/change?sdk=${sdk}&kind=${kind}`)

          assert.strictEqual(response.status, 200, kind)
          // The server shows the type and the content that it got.
          assert.strictEqual(response.body.result, checked, kind)
          assert.strictEqual(toolArguments(attributes().at(-1)), `{"value":${evaluated}}`, kind)
        }
      })

      for (const marker of ['cause', 'stack']) {
        it(`blocks an Error with a deny in its ${marker} (${sdk})`, async () => {
          const response = await get(`/mcp/error?sdk=${sdk}&marker=${marker}`)

          assert.strictEqual(response.status, 403)
          assert.match(toolArguments(attributes().at(-1)), /\[deny\]/)
        })
      }

      it(`sends all the bytes of a 5 MB Uint8Array, and bounds its evaluation (${sdk})`, async () => {
        const bytes = new Uint8Array(5 * 1024 * 1024)
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
        // The trace with the AI Guard span is large, so the test waits for it before the app stops.
        const trace = harness.agent.assertMessageReceived(({ payload }) => {
          assert.ok(payload.flat().some(span => span.name === 'ai_guard'))
        }, 20_000)

        const response = await get(`/mcp/large?sdk=${sdk}`)
        await trace

        assert.strictEqual(response.status, 200)
        // The server shows the type, the length and the digest of the bytes that it got.
        assert.strictEqual(
          response.body.result,
          `Uint8Array:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`
        )
        const evaluated = toolArguments(attributes().at(-1))
        assert.match(evaluated, /^\{"value":\[0,1,2,/)
        assert.match(evaluated, /,"\[Truncated\]"\]\}$/)
        assert.ok(evaluated.length < 4_000_000)
      })

      it(`sends no URL for a transport with a Unicode host (${sdk})`, async () => {
        const response = await get(`/mcp/idn?sdk=${sdk}`)

        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.body.result, 'wrote idn')
        assert.deepStrictEqual((await state()).inProcess, ['streamable_http:idn'])
        // No key identifies the server, so the call gets the evaluation of an ordinary tool call.
        const evaluations = attributes()
        assert.strictEqual(evaluations.length, 1)
        assert.ok(!Object.hasOwn(evaluations[0], 'mcp_servers'))
        assert.deepStrictEqual(Object.keys(evaluations[0].messages[0].tool_calls[0]), ['id', 'function'])
        const sent = JSON.stringify(harness.requests())
        assert.ok(!sent.includes('xn--') && !sent.includes('bücher'))
      })

      for (const transport of ['in_memory', 'stdio']) {
        it(`evaluates null arguments as null (${transport}, ${sdk})`, async () => {
          const response = await callValue(transport, 'null')

          assert.notStrictEqual(response.status, 403)
          assert.deepStrictEqual(attributes().map(toolArguments), ['null'])
        })
      }
    }
  })

  describe('model calls', () => {
    beforeEach(harness.startApp)

    for (const sdk of SDKS) {
      it(`links the model tool call to its MCP server and checks the operation once (${sdk})`, async () => {
        const response = await get(`/mcp/openai?sdk=${sdk}&text=hello&prefix=files__`)

        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.body.toolCallId, 'call_mcp_1')
        assert.deepStrictEqual((await state()).inProcess, ['streamable_http:hello'])

        // The input, then the response with the MCP metadata. The callTool that follows needs no evaluation.
        const evaluations = attributes()
        assert.strictEqual(evaluations.length, 2)
        assert.strictEqual(directCalls().length, 0)
        assert.ok(!Object.hasOwn(evaluations[0], 'mcp_servers'))
        const [server] = evaluations[1].mcp_servers
        assert.match(server.url, LOCAL_ORIGIN)
        assert.deepStrictEqual(evaluations[1].mcp_servers, [{
          id: serverId(`url|${server.url}`),
          managed_by: 'client',
          url: server.url,
          transport: 'streamable_http',
          tools: { files__write_file: 'write_file' },
        }])
        assert.deepStrictEqual(evaluations[1].messages.at(-1).tool_calls, [{
          id: 'call_mcp_1',
          type: 'function',
          function: { name: 'files__write_file', arguments: '{"text":"hello"}' },
          mcp: { server_id: server.id },
        }])
        assertNoSecrets()
      })

      it(`blocks the model tool call in the response before it runs (${sdk})`, async () => {
        // The MCP policy applies to the response, which carries the MCP metadata, and not to the prompt.
        const response = await get(`/mcp/openai?sdk=${sdk}&text=${encodeURIComponent('bad [deny-mcp]')}`)

        assert.strictEqual(response.status, 403)
        assert.deepStrictEqual((await state()).inProcess, [])
        assert.strictEqual(mcpEvaluations().length, 1)
        assert.strictEqual(directCalls().length, 0)
      })

      it(`checks the call itself when the model gets a copy of the schema (${sdk})`, async () => {
        const response = await get(`/mcp/openai?sdk=${sdk}&text=hello&clone=true`)

        assert.strictEqual(response.status, 200)
        const evaluations = attributes()
        assert.strictEqual(evaluations.length, 3)
        assert.strictEqual(evaluations[1].messages.at(-1).tool_calls[0].mcp, undefined)
        assert.strictEqual(mcpEvaluations().length, 1)
        assertDirectCall(mcpEvaluations()[0], 'hello')
      })

      it(`sends the checked values of a marked call that the application changes after the call (${sdk})`,
        async () => {
          const response = await get(`/mcp/openai?sdk=${sdk}&text=hello&mutate=true`)

          assert.strictEqual(response.status, 200)
          assert.strictEqual(response.body.result, 'wrote hello')
          assert.deepStrictEqual((await state()).inProcess, ['streamable_http:hello'])
          assert.strictEqual(attributes().length, 2)
          assert.strictEqual(directCalls().length, 0)
        })
    }

    describe('of @openai/agents 0.14.3, which uses MCP v1', () => {
      // This version gives the model the text of the tool error. Its streamable HTTP server object
      // replaces the error of a failed call with a transport error.
      itChecksAgentsMcpToolCalls(harness, {
        stdio: 'An error occurred while running the tool. Please try again. ' +
          'Error: AIGuardAbortError: Blocked by MCP policy',
        streamable_http: new RegExp(
          '^An error occurred while running the tool\\. Please try again\\. Error: MCPTransportError: ' +
          'MCP streamable HTTP tool call failed for '
        ),
      })
    })
  })

  describe('with the MCP kill switch off', () => {
    before(() => {
      harness.envOverrides = { DD_AI_GUARD_MCP_ENABLED: 'false' }
    })

    after(() => {
      harness.envOverrides = {}
    })

    beforeEach(harness.startApp)

    for (const sdk of SDKS) {
      it(`sends no MCP metadata and makes no MCP check (${sdk})`, async () => {
        const direct = await get(`/mcp/call?sdk=${sdk}&transport=stdio&text=${encodeURIComponent('bad [deny]')}`)
        const model = await get(`/mcp/openai?sdk=${sdk}&text=hello`)

        assert.strictEqual(direct.status, 200)
        assert.strictEqual(model.status, 200)
        assert.deepStrictEqual((await state()).stdio, ['stdio:bad [deny]'])
        // Only the generic input and output evaluations of the model call remain.
        assert.strictEqual(attributes().length, 2)
        const sent = JSON.stringify(harness.requests())
        assert.ok(!sent.includes('"mcp"') && !sent.includes('"mcp_servers"'))
        assert.strictEqual(directCalls().length, 0)
      })
    }
  })

  describe('with the MCP tracing plugin disabled', () => {
    before(() => {
      harness.envOverrides = { DD_TRACE_MODELCONTEXTPROTOCOL_SDK_ENABLED: 'false' }
    })

    after(() => {
      harness.envOverrides = {}
    })

    beforeEach(harness.startApp)

    it('still links model tool calls and enforces direct calls', async () => {
      const model = await get('/mcp/openai?text=hello')
      const blocked = await get(`/mcp/call?transport=stdio&text=${encodeURIComponent('bad [deny]')}`)

      assert.strictEqual(model.status, 200)
      assert.strictEqual(blocked.status, 403)
      const { inProcess, stdio } = await state()
      assert.deepStrictEqual(inProcess, ['streamable_http:hello'])
      assert.deepStrictEqual(stdio, [])
      // The model response carries the MCP metadata, so only the stdio call gets a direct check.
      assert.strictEqual(mcpEvaluations().length, 2)
      assert.strictEqual(directCalls().length, 1)
    })
  })

  describe('esm', () => {
    for (const sdk of SDKS) {
      it(`enforces the decision with the ESM build of the SDK (${sdk})`, async () => {
        let output = ''
        await spawnProcAndExpectExit(path.join(harness.cwd, 'aiguard/mcp-esm.mjs'), {
          cwd: harness.cwd,
          env: { ...harness.env(), MCP_SDK: sdk },
          execArgv: ['--import', 'dd-trace/initialize.mjs'],
        }, data => { output += data })

        assert.match(output, /OUTCOMES \["allowed","AIGuardAbortError"\]/)
        // The blocked call left no side effect.
        const written = fs.readFileSync(harness.sideEffectFile, 'utf8').split('\n').filter(Boolean)
        assert.deepStrictEqual(written, ['stdio:esm allowed'])
        const evaluations = mcpEvaluations()
        assert.strictEqual(evaluations.length, 2)
        assert.strictEqual(assertDirectCall(evaluations[0], 'esm allowed').transport, 'stdio')
        assert.strictEqual(assertDirectCall(evaluations[1], 'esm [deny]').transport, 'stdio')
      })
    }
  })
})
