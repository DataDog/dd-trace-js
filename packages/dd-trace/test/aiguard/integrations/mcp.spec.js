'use strict'

const assert = require('node:assert/strict')
const buffer = require('node:buffer')
const { createHash, createSecretKey } = require('node:crypto')
const { BlockList } = require('node:net')
const { createHistogram } = require('node:perf_hooks')

const { channel, tracingChannel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const { AIGuardAbortError, AIGuardClientError } = require('../../../src/aiguard/errors')
const { MCP_SERVERS } = require('../../../src/aiguard/mcp')
const { SOURCE_AUTO } = require('../../../src/aiguard/tags')

const callToolInterceptChannel = channel('dd-trace:mcp:callTool:intercept')
const listToolsResultChannel = channel('dd-trace:mcp:listTools:result')
// The start channels that the rewriter adds to the MCP server classes of @openai/agents-core.
const agentsMcpServerCallChannels = ['MCPServerStdio', 'MCPServerStreamableHttp', 'MCPServerSSE'].flatMap(className => {
  return ['callTool', 'callToolResult'].map(method => {
    return tracingChannel(`orchestrion:@openai/agents-core:${className}_${method}`).start
  })
})
const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')
const responsesInterceptChannel = channel('dd-trace:openai:responses:intercept')

const legacyStorage = storage('legacy')

const TYPED_ARRAYS = [
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, globalThis.Float16Array,
].filter(TypedArray => typeof TypedArray === 'function')

const MCP_OPTS = { block: true, source: SOURCE_AUTO, integration: 'mcp' }
const OPENAI_OPTS = { block: true, source: SOURCE_AUTO, integration: 'openai' }
const REMOTE_URL = 'https://user:secret@mcp.example.com/api/s3cr3t-t0ken/mcp?token=abc#frag'
const REMOTE_SERVER_ID = 'mcp_b77bc22583ac5006'
const LOCAL_ID = /^dd_mcp_[0-9a-f]{32}$/

/**
 * The server ID rule of the wire contract, computed without the tracer.
 *
 * @param {string} key
 */
function serverId (key) {
  return 'mcp_' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

class FakeStream {
  constructor (chunks) {
    this.chunks = chunks
  }

  tee () {
    return [new FakeStream(this.chunks), new FakeStream(this.chunks)]
  }

  [Symbol.asyncIterator] () {
    let index = 0
    return {
      next: () => Promise.resolve(index < this.chunks.length
        ? { done: false, value: this.chunks[index++] }
        : { done: true, value: undefined }),
    }
  }
}

/**
 * Creates the local trace of an outer operation, with a span for the model request inside it.
 */
function createTrace () {
  const trace = { started: /** @type {object[]} */ ([]) }
  const span = () => {
    const created = { context: () => ({ _trace: trace }) }
    trace.started.push(created)
    return created
  }
  const root = span()
  return { trace, root, span }
}

/**
 * Creates a client with its transport, as the instrumentation publishes them.
 *
 * @param {object} transportInfo
 */
function createClient (transportInfo) {
  return { client: { name: 'client' }, transport: { name: 'transport' }, transportInfo }
}

/**
 * Publishes the listTools result of a client and returns the listed tools.
 *
 * @param {ReturnType<typeof createClient>} mcpClient
 * @param {string[]} names
 */
function listTools (mcpClient, names) {
  const tools = names.map(name => ({ name, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }))
  listToolsResultChannel.publish({ ...mcpClient, tools })
  return tools
}

/**
 * @typedef {object} PublishedCall
 * @property {Array<{ name?: string, arguments?: unknown }>} arguments
 * @property {() => Promise<unknown>|undefined} [beforeCall]
 */

/**
 * Publishes a callTool intercept and returns the context after the integration changed it.
 *
 * @param {ReturnType<typeof createClient>} mcpClient
 * @param {{ name?: string, arguments?: unknown }} params
 * @returns {PublishedCall}
 */
function publishCallTool (mcpClient, params) {
  const ctx = { ...mcpClient, arguments: [params] }
  callToolInterceptChannel.publish(ctx)
  return ctx
}

/**
 * Publishes a callTool intercept and runs its hook in the context of the active span.
 *
 * @param {ReturnType<typeof createClient>} mcpClient
 * @param {object} params
 * @param {object} [activeSpan]
 */
function callTool (mcpClient, params, activeSpan) {
  /** @type {{ beforeCall?: () => Promise<unknown>|undefined, [key: string]: unknown }} */
  const ctx = { ...mcpClient, arguments: [params] }
  callToolInterceptChannel.publish(ctx)
  const { beforeCall } = ctx
  assert.ok(beforeCall, 'the integration installs a beforeCall hook')
  // Without a span, the hook runs in the current store, as in the SDK.
  return activeSpan ? legacyStorage.run({ span: activeSpan }, () => beforeCall()) : beforeCall()
}

describe('AIGuard MCP integration', () => {
  let evaluate
  let log
  let mcp
  let openai

  beforeEach(() => {
    evaluate = sinon.stub().resolves({ action: 'ALLOW' })
    log = { debug: sinon.stub(), error: sinon.stub() }
    const evaluateModule = proxyquire('../../../src/aiguard/integrations/evaluate', { '../../log': log })
    mcp = proxyquire('../../../src/aiguard/integrations/mcp', { '../../log': log })
    openai = proxyquire('../../../src/aiguard/integrations/openai', { './evaluate': evaluateModule })
    mcp.enable({ evaluate }, true)
  })

  afterEach(() => {
    mcp.disable()
    openai.disable()
    sinon.restore()
  })

  describe('callTool check', () => {
    const remote = () => createClient({ type: 'streamable_http', url: new URL(REMOTE_URL) })

    it('holds the call until the evaluation completes', async () => {
      /** @type {(value: unknown) => void} */
      let complete = () => {}
      evaluate.returns(new Promise(resolve => { complete = resolve }))
      let settled = false

      const call = /** @type {Promise<unknown>} */ (callTool(remote(), { name: 'search', arguments: { q: 'x' } }))
      const pending = call.then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))

      assert.strictEqual(settled, false)
      complete({ action: 'ALLOW' })
      await pending
      assert.strictEqual(settled, true)
    })

    it('sends one assistant message with the tool call and its server', async () => {
      await callTool(remote(), { name: 'search', arguments: { q: 'x', n: 2 } })

      sinon.assert.calledOnce(evaluate)
      const [messages, opts] = evaluate.firstCall.args
      const id = messages[0].tool_calls[0].id
      assert.match(id, LOCAL_ID)
      assert.deepStrictEqual(messages, [{
        role: 'assistant',
        tool_calls: [{
          id,
          function: { name: 'search', arguments: '{"q":"x","n":2}' },
          mcp: { server_id: REMOTE_SERVER_ID },
        }],
      }])
      assert.deepStrictEqual(opts, {
        ...MCP_OPTS,
        [MCP_SERVERS]: [{
          id: REMOTE_SERVER_ID,
          managed_by: 'client',
          url: 'https://mcp.example.com',
          transport: 'streamable_http',
          tools: { search: 'search' },
        }],
      })
    })

    it('gives each direct call its own local ID and empty arguments by default', async () => {
      const client = remote()

      await callTool(client, { name: 'search' })
      await callTool(client, { name: 'search' })

      const [first, second] = evaluate.getCalls().map(call => call.args[0][0].tool_calls[0])
      assert.strictEqual(first.function.arguments, '{}')
      assert.notStrictEqual(first.id, second.id)
    })

    it('rejects with the AIGuardAbortError of a block', async () => {
      const error = new AIGuardAbortError('blocked', [], {}, [])
      evaluate.rejects(error)

      const call = /** @type {Promise<unknown>} */ (callTool(remote(), { name: 'search', arguments: {} }))
      await assert.rejects(call, candidate => candidate === error)
    })

    it('passes the local block setting to the evaluation', async () => {
      mcp.disable()
      mcp.enable({ evaluate }, false)

      await callTool(remote(), { name: 'search', arguments: {} })

      assert.strictEqual(evaluate.firstCall.args[1].block, false)
    })

    it('lets the call run for allow and monitor decisions', async () => {
      evaluate.resolves({ action: 'DENY', reason: 'monitored' })

      assert.strictEqual(await callTool(remote(), { name: 'search', arguments: {} }), undefined)
    })

    it('fails open when the evaluation fails', async () => {
      evaluate.rejects(new AIGuardClientError('unavailable', { telemetryType: 'client_error' }))

      assert.strictEqual(await callTool(remote(), { name: 'search', arguments: {} }), undefined)
      sinon.assert.calledWithMatch(log.debug, 'AIGuard: unexpected error during MCP tool call evaluation: %s')
    })

    it('fails open when the evaluation throws synchronously', () => {
      evaluate.throws(new Error('boom'))

      assert.strictEqual(callTool(remote(), { name: 'search', arguments: {} }), undefined)
      sinon.assert.calledWithMatch(log.debug, 'AIGuard: unable to evaluate the MCP tool call: %s', 'boom')
    })

    it('leaves calls without params or a tool name to the SDK', () => {
      assert.strictEqual(callTool(remote(), { arguments: {} }), undefined)
      assert.strictEqual(callTool(remote(), undefined), undefined)
      sinon.assert.notCalled(evaluate)
    })

    it('evaluates a server that no key identifies as an ordinary tool call', async () => {
      await callTool(createClient({ type: 'in_process' }), { name: 'search', arguments: { q: 'x' } })

      const [messages, opts] = evaluate.firstCall.args
      assert.deepStrictEqual(messages, [{
        role: 'assistant',
        tool_calls: [{ id: messages[0].tool_calls[0].id, function: { name: 'search', arguments: '{"q":"x"}' } }],
      }])
      assert.deepStrictEqual(opts, MCP_OPTS)
      assert.strictEqual(Object.getOwnPropertySymbols(opts).length, 0)
    })

    it('sends only the command and the safe arguments of a stdio server', async () => {
      const client = createClient({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@scope/pkg@1.2.3', '--api-key', 'secret'],
      })

      await callTool(client, { name: 'search', arguments: {} })

      const npxServerId = serverId('stdio|npx|@scope/pkg@1.2.3')
      assert.deepStrictEqual(evaluate.firstCall.args[1][MCP_SERVERS], [{
        id: npxServerId,
        managed_by: 'client',
        transport: 'stdio',
        command: 'npx',
        args: ['@scope/pkg@1.2.3'],
        tools: { search: 'search' },
      }])
    })

    it('keeps the server of each client when two clients expose the same tool', async () => {
      const first = createClient({ type: 'sse', url: new URL('https://one.example.com/sse') })
      const second = createClient({ type: 'stdio', command: 'uvx', args: ['mcp-example'] })

      await callTool(first, { name: 'search', arguments: {} })
      await callTool(second, { name: 'search', arguments: {} })

      const servers = evaluate.getCalls().map(call => call.args[1][MCP_SERVERS][0])
      assert.deepStrictEqual(servers.map(server => [server.id, server.transport]), [
        [serverId('url|https://one.example.com'), 'sse'],
        ['mcp_0f2f11f8cafdbcc5', 'stdio'],
      ])
    })

    it('keeps the server entry of a transport for its whole life', async () => {
      const client = remote()
      await callTool(client, { name: 'search', arguments: {} })
      client.transportInfo.url = new URL('https://other.example.com/mcp')

      await callTool(client, { name: 'search', arguments: {} })

      const ids = evaluate.getCalls().map(call => call.args[1][MCP_SERVERS][0].id)
      assert.deepStrictEqual(ids, [REMOTE_SERVER_ID, REMOTE_SERVER_ID])
    })

    it('does not change the call arguments', async () => {
      const params = { name: 'search', arguments: { q: 'x', nested: { a: [1] } } }
      const snapshot = structuredClone(params)

      await callTool(remote(), params)

      assert.deepStrictEqual(params, snapshot)
    })

    it('makes the SDK send a copy of the checked params', async () => {
      const params = { name: 'search', arguments: { q: 'x', nested: { a: [1] } }, _meta: { progressToken: 1 } }
      const ctx = publishCallTool(remote(), params)

      const pending = ctx.beforeCall?.()
      params.name = 'changed'
      params.arguments.q = 'changed'
      params.arguments.nested.a.push(2)
      await pending

      const sent = ctx.arguments[0]
      assert.notStrictEqual(sent, params)
      assert.deepStrictEqual(sent, {
        name: 'search',
        arguments: { q: 'x', nested: { a: [1] } },
        _meta: { progressToken: 1 },
      })
      const [message] = evaluate.firstCall.args[0]
      assert.strictEqual(message.tool_calls[0].function.arguments, JSON.stringify(sent.arguments))
    })

    it('keeps undefined call arguments in the copy', async () => {
      const params = { name: 'search' }
      const ctx = publishCallTool(remote(), params)

      await ctx.beforeCall?.()

      assert.notStrictEqual(ctx.arguments[0], params)
      assert.deepStrictEqual(ctx.arguments[0], { name: 'search' })
      assert.strictEqual(evaluate.firstCall.args[0][0].tool_calls[0].function.arguments, '{}')
    })

    it('sends the arguments in the order of the application', async () => {
      await callTool(remote(), { name: 'search', arguments: { b: '1', a: '2' } })

      assert.strictEqual(evaluate.firstCall.args[0][0].tool_calls[0].function.arguments, '{"b":"1","a":"2"}')
    })

    describe('arguments that the server gets', () => {
      const inMemory = () => createClient({ type: 'in_process' })
      /**
       * @param {{ arguments: IArguments|unknown[] }} ctx
       * @returns {Record<string, unknown>}
       */
      const sentArguments = ctx => /** @type {{ arguments: Record<string, unknown> }} */ (ctx.arguments[0]).arguments
      const evaluatedArguments = () => evaluate.firstCall.args[0][0].tool_calls[0].function.arguments

      /**
       * Asserts a copy with the same type and content, and another identity.
       *
       * @param {unknown} copy
       * @param {unknown} original
       */
      function assertSnapshot (copy, original) {
        assert.notStrictEqual(copy, original)
        assert.strictEqual(Object.getPrototypeOf(copy), Object.getPrototypeOf(original))
        assert.deepStrictEqual(copy, original)
      }

      it('evaluates the safe JSON form of a call that a JSON transport cannot send, and keeps the params', async () => {
        const circular = { name: 'node' }
        circular.self = circular
        const params = { name: 'search', arguments: { value: 1n, circular } }
        const ctx = publishCallTool(remote(), params)

        await ctx.beforeCall?.()

        assert.strictEqual(evaluatedArguments(), '{"value":"1","circular":{"name":"node","self":"[Circular]"}}')
        assert.strictEqual(ctx.arguments[0], params)
      })

      it('evaluates a value that a JSON transport fails to serialize only once', async () => {
        let reads = 0
        const params = {
          name: 'search',
          arguments: {
            get text () {
              if (reads++ === 0) throw new Error('not ready')
              return 'bad [deny]'
            },
          },
        }
        const ctx = publishCallTool(remote(), params)

        await ctx.beforeCall?.()

        assert.strictEqual(evaluatedArguments(), '{"text":"bad [deny]"}')
        assert.strictEqual(ctx.arguments[0], params)
      })

      it('blocks a call that a JSON transport cannot send when the evaluation denies it', async () => {
        const error = new AIGuardAbortError('blocked', [], {}, [])
        evaluate.rejects(error)

        const call = /** @type {Promise<unknown>} */ (callTool(remote(), { name: 'search', arguments: { value: 1n } }))
        await assert.rejects(call, candidate => candidate === error)
      })

      it('evaluates no arguments when JSON leaves out the value of a JSON transport', async () => {
        const params = { name: 'search', arguments: () => {} }
        const ctx = publishCallTool(remote(), params)

        await ctx.beforeCall?.()

        assert.strictEqual(evaluatedArguments(), '{}')
        assert.notStrictEqual(ctx.arguments[0], params)
        assert.strictEqual(sentArguments(ctx), params.arguments)
      })

      it('keeps the types for an in-process transport, and a Buffer arrives as a Uint8Array', async () => {
        const when = new Date(0)
        const data = Buffer.from('abc')
        const params = { name: 'search', arguments: { when, data, list: [1], nested: { cmd: 'ls' } } }
        const ctx = publishCallTool(inMemory(), params)

        await ctx.beforeCall?.()
        params.arguments.when = new Date(1)
        params.arguments.list.push(2)
        params.arguments.nested.cmd = 'rm'

        const sent = sentArguments(ctx)
        assert.deepStrictEqual(sent, {
          when: new Date(0),
          data: new Uint8Array([97, 98, 99]),
          list: [1],
          nested: { cmd: 'ls' },
        })
        assertSnapshot(sent.when, when)
        // The structured clone of a Buffer is a Uint8Array with the same bytes.
        assert.strictEqual(Object.getPrototypeOf(sent.data), Uint8Array.prototype)
        assert.strictEqual(
          evaluatedArguments(),
          '{"when":"1970-01-01T00:00:00.000Z","data":[97,98,99],"list":[1],"nested":{"cmd":"ls"}}'
        )
      })

      it('sends the checked values when the application changes built-in objects in the check', async () => {
        const args = {
          when: new Date(0),
          bytes: new Uint8Array([1, 2, 3]),
          buffer: new Uint8Array([4, 5]).buffer,
          view: new DataView(new Uint8Array([6, 7]).buffer),
          map: new Map([['a', 1], ['b', 2]]),
          set: new Set([1]),
          pattern: /a+/g,
          error: Object.assign(new Error('boom'), { stack: 'Error: boom' }),
          big: 7n,
          nested: { inner: { list: [1] } },
        }
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: args })

        const pending = ctx.beforeCall?.()
        args.when.setTime(1000)
        args.bytes.fill(0)
        new Uint8Array(args.buffer).fill(9)
        args.view.setUint8(0, 9)
        args.map.set('a', 9)
        args.map.delete('b')
        args.set.add(2)
        args.error.message = 'changed'
        args.nested.inner.list.push(2)
        await pending

        const sent = sentArguments(ctx)
        const original = /** @type {Record<string, unknown>} */ (args)
        for (const key of ['when', 'bytes', 'buffer', 'view', 'map', 'set', 'pattern', 'error', 'nested']) {
          assert.notStrictEqual(sent[key], original[key])
          assert.strictEqual(Object.getPrototypeOf(sent[key]), Object.getPrototypeOf(original[key]))
        }
        assert.deepStrictEqual({ ...sent, error: undefined }, {
          when: new Date(0),
          bytes: new Uint8Array([1, 2, 3]),
          buffer: new Uint8Array([4, 5]).buffer,
          view: new DataView(new Uint8Array([6, 7]).buffer),
          map: new Map([['a', 1], ['b', 2]]),
          set: new Set([1]),
          pattern: /a+/g,
          error: undefined,
          big: 7n,
          nested: { inner: { list: [1] } },
        })
        assert.strictEqual(/** @type {Error} */ (sent.error).message, 'boom')
        assert.strictEqual(evaluatedArguments(), JSON.stringify({
          when: '1970-01-01T00:00:00.000Z',
          bytes: [1, 2, 3],
          buffer: [4, 5],
          view: [6, 7],
          map: [['a', 1], ['b', 2]],
          set: [1],
          pattern: '/a+/g',
          error: { name: 'Error', message: 'boom', stack: 'Error: boom' },
          big: '7',
          nested: { inner: { list: [1] } },
        }))
      })

      it('sends a class instance as a plain object that keeps its nested types', async () => {
        class Point {
          x = 1
          when = new Date(0)
          tags = new Set(['a'])
        }
        class Stamp extends Date {}
        class Registry extends Map {}
        const point = new Point()
        const args = { point, stamp: new Stamp(0), registry: new Registry([['a', 1]]) }
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: args })

        const pending = ctx.beforeCall?.()
        point.x = 2
        point.when.setTime(1000)
        await pending

        const sent = sentArguments(ctx)
        // The structured clone of a class instance, or of a subclass of a built-in object, has the
        // prototype of the plain object or of the built-in object.
        assert.strictEqual(Object.getPrototypeOf(sent.point), Object.prototype)
        assert.deepStrictEqual(sent.point, { x: 1, when: new Date(0), tags: new Set(['a']) })
        assert.strictEqual(Object.getPrototypeOf(sent.stamp), Date.prototype)
        assert.strictEqual(Object.getPrototypeOf(sent.registry), Map.prototype)
        assert.strictEqual(evaluatedArguments(), JSON.stringify({
          point: { x: 1, when: '1970-01-01T00:00:00.000Z', tags: ['a'] },
          stamp: '1970-01-01T00:00:00.000Z',
          registry: [['a', 1]],
        }))
      })

      for (const [description, value, json] of /** @type {Array<[string, unknown, string]>} */ ([
        ['a proxy', new Proxy({ a: 1 }, {}), '{"a":1}'],
        ['a function', { a: 1, run () {} }, '{"a":1}'],
        ['a symbol', { a: 1, tag: Symbol('tag'), list: [Symbol('item')] }, '{"a":1,"list":[null]}'],
        ['a toJSON method', { a: 1, toJSON () { return { b: 2 } } }, '{"b":2}'],
        // The check cannot see the content of these objects of the platform.
        ['a Blob', new Blob(['rm -rf / [deny]']), '{}'],
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- The test skips a runtime without File.
        ...(typeof buffer.File === 'function' ? [['a File', new buffer.File(['rm -rf / [deny]'], 'a.txt'), '{}']] : []),
        ['a KeyObject', createSecretKey(Buffer.from('key')), '{}'],
        ['a URL, a Promise and a WeakMap', {
          url: new URL('https://mcp.example.com/a'),
          pending: Promise.resolve(),
          weak: new WeakMap(),
        }, '{"url":"https://mcp.example.com/a","pending":{},"weak":{}}'],
      ])) {
        it(`sends the JSON form of arguments with ${description}, as on the wire`, async () => {
          const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { value } })

          await ctx.beforeCall?.()

          assert.strictEqual(evaluatedArguments(), `{"value":${json}}`)
          assert.deepStrictEqual(sentArguments(ctx), JSON.parse(evaluatedArguments()))
        })
      }

      // The clones of these objects share a native handle with the application, and JSON.stringify
      // calls their toJSON before the replacer.
      /** @type {Array<[string, () => [object, () => void], string]>} */
      const nativeHandles = [
        ['a BlockList', () => {
          const list = new BlockList()
          list.addAddress('10.0.0.1')
          return [list, () => list.addAddress('10.9.9.9')]
        }, '10.9.9.9'],
        ['a RecordableHistogram', () => {
          const histogram = createHistogram()
          histogram.record(5)
          return [histogram, () => histogram.record(9)]
        }, '"max":9'],
      ]
      for (const [description, create, changed] of nativeHandles) {
        for (const [place, wrap] of /** @type {Array<[string, (value: unknown) => object]>} */ ([
          ['directly', value => ({ value })],
          ['inside a Map', value => ({ map: new Map([['value', value]]) })],
          ['past the cap', value => ({ items: new Array(1_000_001).fill(0), later: { value } })],
        ])) {
          it(`sends the JSON form of ${description} ${place}, so a change in the check cannot reach it`, async () => {
            const [value, change] = create()
            const ctx = publishCallTool(inMemory(), { name: 'search', arguments: wrap(value) })

            const pending = ctx.beforeCall?.()
            change()
            await pending

            const evaluated = evaluatedArguments()
            assert.ok(!evaluated.includes(changed))
            assert.deepStrictEqual(sentArguments(ctx), JSON.parse(evaluated))
          })
        }
      }

      it('still sends a Date as a clone, also inside a Map, and evaluates its ISO string', async () => {
        const when = new Date(0)
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { when, map: new Map([['when', when]]) } })

        const pending = ctx.beforeCall?.()
        when.setTime(1000)
        await pending

        const sent = sentArguments(ctx)
        assertSnapshot(sent.when, new Date(0))
        assert.strictEqual(/** @type {Map<string, unknown>} */ (sent.map).get('when'), sent.when)
        assert.strictEqual(
          evaluatedArguments(),
          '{"when":"1970-01-01T00:00:00.000Z","map":[["when","1970-01-01T00:00:00.000Z"]]}'
        )
      })

      it('evaluates the cause and the stack of an Error, which the server gets', async () => {
        const error = new Error('boom', { cause: { reason: 'cause [deny]' } })
        error.stack = 'custom stack [deny]'
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { error } })

        await ctx.beforeCall?.()

        assert.strictEqual(evaluatedArguments(), JSON.stringify({
          error: { name: 'Error', message: 'boom', stack: 'custom stack [deny]', cause: { reason: 'cause [deny]' } },
        }))
        const sent = /** @type {Error} */ (sentArguments(ctx).error)
        assert.strictEqual(sent.stack, 'custom stack [deny]')
        assert.deepStrictEqual(sent.cause, { reason: 'cause [deny]' })
      })

      it('blocks an Error with a deny in its cause', async () => {
        const abort = new AIGuardAbortError('blocked', [], {}, [])
        evaluate.callsFake(messages => {
          const { arguments: args } = messages[0].tool_calls[0].function
          return args.includes('[deny]') ? Promise.reject(abort) : Promise.resolve()
        })
        const error = new Error('boom', { cause: new Error('cause [deny]') })
        error.stack = 'Error: boom'

        const call = /** @type {Promise<unknown>} */ (callTool(inMemory(), { name: 'search', arguments: { error } }))
        await assert.rejects(call, candidate => candidate === abort)
      })

      it('finds a SharedArrayBuffer past the entries of the evaluation, and sends the JSON form', async () => {
        const items = new Array(1_000_001).fill(0)
        const view = new Uint8Array(new SharedArrayBuffer(2))
        view[0] = 1
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { items, view } })

        const pending = ctx.beforeCall?.()
        view[0] = 7
        await pending

        // The server gets the parsed text, so the write of the application cannot reach it.
        const sent = sentArguments(ctx)
        assert.deepStrictEqual(sent.view, { '[Truncated]': '[Truncated]' })
        assert.deepStrictEqual(sent, JSON.parse(evaluatedArguments()))
      })

      it('sends the JSON form of a SharedArrayBuffer, so a write of the application cannot reach it', async () => {
        const view = new Uint8Array(new SharedArrayBuffer(2))
        view[0] = 1
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { view, buffer: view.buffer } })

        const pending = ctx.beforeCall?.()
        view[0] = 9
        await pending

        // A structured clone shares the memory of a SharedArrayBuffer, so it cannot be the sent value.
        assert.strictEqual(evaluatedArguments(), '{"view":{"0":1,"1":0},"buffer":{}}')
        assert.deepStrictEqual(sentArguments(ctx), { view: { 0: 1, 1: 0 }, buffer: {} })
      })

      it('evaluates the content of built-in objects for an in-process transport', async () => {
        const args = {
          map: new Map(/** @type {Array<[unknown, unknown]>} */ ([[1, 'one'], [{ k: 1 }, [2]]])),
          set: new Set(['a', 1n]),
          pattern: /ab+c/gi,
          floats: new Float64Array([1.5, Number.NaN, -0]),
          bigints: new BigInt64Array([-1n, 2n]),
          buffer: new Uint8Array([7, 8]).buffer,
          view: new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2),
          error: Object.assign(new TypeError('bad'), { code: 'E1', stack: 'TypeError: bad' }),
          big: 12n,
          invalid: new Date(Number.NaN),
        }
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: args })

        await ctx.beforeCall?.()

        assert.strictEqual(evaluatedArguments(), JSON.stringify({
          map: [[1, 'one'], [{ k: 1 }, [2]]],
          set: ['a', '1'],
          pattern: '/ab+c/gi',
          floats: [1.5, null, 0],
          bigints: ['-1', '2'],
          buffer: [7, 8],
          view: [2, 3],
          error: { name: 'TypeError', message: 'bad', stack: 'TypeError: bad' },
          big: '12',
          invalid: null,
        }))
        const sent = sentArguments(ctx)
        const original = /** @type {Record<string, unknown>} */ (args)
        for (const key of ['map', 'set', 'pattern', 'floats', 'bigints', 'buffer', 'view']) {
          assertSnapshot(sent[key], original[key])
        }
        // The clone of an Error keeps its type, its name and its message, but not its other properties.
        const error = /** @type {Error & { code?: string }} */ (sent.error)
        assert.strictEqual(Object.getPrototypeOf(error), TypeError.prototype)
        assert.strictEqual(error.message, 'bad')
        assert.strictEqual(error.code, undefined)
        assert.strictEqual(sent.big, 12n)
      })

      for (const TypedArray of TYPED_ARRAYS) {
        it(`sends a copy of a ${TypedArray.name} that a change in the check cannot reach`, async () => {
          const isBigInt = TypedArray === BigInt64Array || TypedArray === BigUint64Array
          const array = new TypedArray(isBigInt ? [1n, 2n] : [1, 2])
          const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { array } })

          const pending = ctx.beforeCall?.()
          array.fill(isBigInt ? 0n : 0)
          await pending

          const sent = sentArguments(ctx).array
          assert.notStrictEqual(sent, array)
          assert.strictEqual(Object.getPrototypeOf(sent), TypedArray.prototype)
          assert.deepStrictEqual(sent, new TypedArray(isBigInt ? [1n, 2n] : [1, 2]))
          assert.strictEqual(evaluatedArguments(), isBigInt ? '{"array":["1","2"]}' : '{"array":[1,2]}')
        })
      }

      it('reads a getter once on the clone path', async () => {
        let reads = 0
        const value = {
          get count () {
            reads++
            return 1
          },
        }
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { value } })

        await ctx.beforeCall?.()

        assert.strictEqual(reads, 1)
        assert.deepStrictEqual(sentArguments(ctx), { value: { count: 1 } })
        assert.strictEqual(evaluatedArguments(), '{"value":{"count":1}}')
      })

      it('keeps shared values and cycles across Map and Set entries for an in-process transport', async () => {
        const shared = { id: 1 }
        /** @type {Map<unknown, unknown>} */
        const map = new Map([[shared, shared]])
        /** @type {Set<unknown>} */
        const set = new Set([shared])
        map.set('self', map)
        set.add(set)
        map.set('set', set)
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { shared, map, set } })

        await ctx.beforeCall?.()

        const sent = sentArguments(ctx)
        const sentMap = /** @type {Map<unknown, unknown>} */ (sent.map)
        const sentSet = /** @type {Set<unknown>} */ (sent.set)
        const [[entryKey, entryValue]] = sentMap
        assert.notStrictEqual(sent.shared, shared)
        assert.strictEqual(entryKey, sent.shared)
        assert.strictEqual(entryValue, sent.shared)
        assert.strictEqual(sentMap.get('self'), sentMap)
        assert.strictEqual(sentMap.get('set'), sentSet)
        assert.ok(sentSet.has(sent.shared))
        assert.ok(sentSet.has(sentSet))
        assert.strictEqual(evaluatedArguments(), JSON.stringify({
          shared: { id: 1 },
          map: [[{ id: 1 }, { id: 1 }], ['self', '[Circular]'], ['set', [{ id: 1 }, '[Circular]']]],
          set: [{ id: 1 }, '[Circular]'],
        }))
      })

      it('sends the JSON form of a value 100,000 levels deep without a stack overflow', async () => {
        const depth = 100_000
        const root = {}
        let node = root
        for (let i = 0; i < depth; i++) {
          node.next = {}
          node = node.next
        }
        node.end = [new Date(0)]
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: root })

        await ctx.beforeCall?.()

        const expected = `${'{"next":'.repeat(depth)}{"end":["1970-01-01T00:00:00.000Z"]}${'}'.repeat(depth)}`
        assert.strictEqual(evaluatedArguments(), expected)
        // The structured clone fails for this depth, so the server gets the parsed text.
        let sent = sentArguments(ctx)
        for (let i = 0; i < depth; i++) sent = /** @type {Record<string, unknown>} */ (sent.next)
        assert.deepStrictEqual(sent, { end: ['1970-01-01T00:00:00.000Z'] })
      })

      it('sends the full clone of a sparse array with a huge length, and bounds its evaluation', async () => {
        const sparse = []
        sparse.length = 2 ** 32 - 1
        sparse[1] = 'x'
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { sparse } })

        await ctx.beforeCall?.()

        const sent = /** @type {unknown[]} */ (sentArguments(ctx).sparse)
        assert.notStrictEqual(sent, sparse)
        assert.strictEqual(sent.length, 2 ** 32 - 1)
        assert.deepStrictEqual(Object.keys(sent), ['1'])
        assert.strictEqual(sent[1], 'x')
        const evaluated = evaluatedArguments()
        assert.match(evaluated, /^\{"sparse":\[null,"x",null,/)
        assert.match(evaluated, /,null,"\[Truncated\]"\]\}$/)
        assert.ok(evaluated.length < 6_000_000)
      })

      it('sends all the bytes of a 5 MB Uint8Array, and bounds its evaluation', async () => {
        const bytes = new Uint8Array(5 * 1024 * 1024)
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { bytes } })

        const pending = ctx.beforeCall?.()
        bytes.fill(0)
        await pending

        const sent = /** @type {Uint8Array} */ (sentArguments(ctx).bytes)
        assert.notStrictEqual(sent, bytes)
        assert.strictEqual(Object.getPrototypeOf(sent), Uint8Array.prototype)
        assert.strictEqual(sent.length, 5 * 1024 * 1024)
        assert.ok(sent.every((byte, index) => byte === index % 251))
        const evaluated = evaluatedArguments()
        assert.match(evaluated, /^\{"bytes":\[0,1,2,/)
        assert.match(evaluated, /,"\[Truncated\]"\]\}$/)
        assert.ok(evaluated.length < 4_000_000)
      })

      it('sends every key of an object with 2,000,000 keys, and bounds its evaluation', async () => {
        // Keys that are integers keep the object fast to build.
        /** @type {Record<string, number>} */
        const wide = {}
        for (let i = 0; i < 2_000_000; i++) wide[i] = i
        const ctx = publishCallTool(inMemory(), { name: 'search', arguments: { wide } })

        await ctx.beforeCall?.()

        const sent = /** @type {Record<string, number>} */ (sentArguments(ctx).wide)
        assert.notStrictEqual(sent, wide)
        assert.strictEqual(Object.keys(sent).length, 2_000_000)
        assert.strictEqual(sent[1_999_999], 1_999_999)
        const evaluated = evaluatedArguments()
        assert.match(evaluated, /^\{"wide":\{"0":0,"1":1,/)
        assert.match(evaluated, /,"\[Truncated\]":"\[Truncated\]"\}\}$/)
        assert.ok(evaluated.length < 20_000_000)
      })

      it('evaluates a value 100,000 levels deep that JSON.stringify cannot write for a JSON transport', async () => {
        const depth = 100_000
        const root = {}
        let node = root
        for (let i = 0; i < depth; i++) {
          node.next = {}
          node = node.next
        }
        const params = { name: 'search', arguments: root }
        assert.throws(() => JSON.stringify(root), RangeError)
        const ctx = publishCallTool(remote(), params)

        await ctx.beforeCall?.()

        assert.strictEqual(evaluatedArguments(), `${'{"next":'.repeat(depth)}{}${'}'.repeat(depth)}`)
        // The SDK cannot send these arguments either, so the params stay as they are.
        assert.strictEqual(ctx.arguments[0], params)
      })

      it('sends the nested values that the check read when the application changes them in the check', async () => {
        const params = { name: 'search', arguments: { text: 'x', value: { cmd: 'ls' } } }
        const ctx = publishCallTool(inMemory(), params)

        const pending = ctx.beforeCall?.()
        params.arguments.value.cmd = 'rm [deny]'
        await pending

        assert.strictEqual(evaluatedArguments(), '{"text":"x","value":{"cmd":"ls"}}')
        assert.deepStrictEqual(sentArguments(ctx), { text: 'x', value: { cmd: 'ls' } })
      })

      it('keeps shared values and cycles in the copy for an in-process transport', async () => {
        const shared = { id: 1 }
        const cycle = { name: 'node' }
        cycle.self = cycle
        const params = { name: 'search', arguments: { first: shared, second: shared, list: [shared], cycle } }
        const ctx = publishCallTool(inMemory(), params)

        await ctx.beforeCall?.()

        const sent = /** @type {{ first: object, second: object, list: object[], cycle: { self: object } }} */ (
          sentArguments(ctx)
        )
        assert.notStrictEqual(sent.first, shared)
        assert.deepStrictEqual(sent.first, shared)
        assert.strictEqual(sent.second, sent.first)
        assert.strictEqual(sent.list[0], sent.first)
        assert.notStrictEqual(sent.cycle, cycle)
        assert.strictEqual(sent.cycle.self, sent.cycle)
      })

      it('evaluates the values that JSON cannot write for an in-process transport', async () => {
        const cycle = { name: 'node' }
        cycle.self = cycle
        const unreadable = {
          get secret () { throw new Error('no access') },
          toJSONFails: { toJSON () { throw new Error('no JSON') } },
        }
        const params = { name: 'search', arguments: { big: 12345678901234567890n, cycle, unreadable } }
        const ctx = publishCallTool(inMemory(), params)

        await ctx.beforeCall?.()

        // The getter that throws stops the structured clone, so the server gets the JSON form.
        const expected = {
          big: '12345678901234567890',
          cycle: { name: 'node', self: '[Circular]' },
          unreadable: { secret: '[Unreadable]', toJSONFails: '[Unreadable]' },
        }
        assert.deepStrictEqual(JSON.parse(evaluatedArguments()), expected)
        assert.deepStrictEqual(sentArguments(ctx), expected)
      })

      it('blocks an in-process call with values that JSON cannot write', async () => {
        const error = new AIGuardAbortError('blocked', [], {}, [])
        evaluate.rejects(error)
        const cycle = {}
        cycle.self = cycle

        const call = /** @type {Promise<unknown>} */ (callTool(inMemory(), { name: 'search', arguments: { cycle } }))
        await assert.rejects(call, candidate => candidate === error)
      })

      /** @type {Array<[string, () => object]>} */
      const clients = [['a JSON transport', remote], ['an in-process transport', inMemory]]
      for (const [description, mcpClient] of clients) {
        it(`evaluates null arguments as null for ${description}`, async () => {
          const ctx = publishCallTool(mcpClient(), { name: 'search', arguments: null })

          await ctx.beforeCall?.()

          assert.strictEqual(evaluatedArguments(), 'null')
          assert.strictEqual(sentArguments(ctx), null)
        })

        it(`sends the name and the arguments that the check read for ${description}`, async () => {
          let nameReads = 0
          let argumentReads = 0
          const params = {
            get name () { return nameReads++ === 0 ? 'search' : 'delete' },
            get arguments () { return argumentReads++ === 0 ? { q: 'checked' } : { q: 'other' } },
            _meta: { progressToken: 1 },
          }
          const ctx = publishCallTool(mcpClient(), params)

          await ctx.beforeCall?.()

          const { function: checked } = evaluate.firstCall.args[0][0].tool_calls[0]
          assert.deepStrictEqual(checked, { name: 'search', arguments: '{"q":"checked"}' })
          assert.deepStrictEqual(ctx.arguments[0], {
            name: 'search',
            arguments: { q: 'checked' },
            _meta: { progressToken: 1 },
          })
          assert.deepStrictEqual(Object.keys(ctx.arguments[0]), ['name', 'arguments', '_meta'])
          assert.strictEqual(nameReads, 1)
          assert.strictEqual(argumentReads, 1)
        })
      }

      it('evaluates a name that is not a string as a string', async () => {
        await callTool(remote(), { name: 42, arguments: {} })

        assert.strictEqual(evaluate.firstCall.args[0][0].tool_calls[0].function.name, '42')
      })
    })

    describe('configured server name of @openai/agents', () => {
      const stdio = () => createClient({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'] })

      /**
       * @param {ReturnType<typeof createClient>} mcpClient
       * @param {object} server The public MCP server object of the agent.
       */
      function callFromAgent (mcpClient, server) {
        const [startChannel] = agentsMcpServerCallChannels
        return startChannel.runStores({ self: server, arguments: [] }, () => callTool(mcpClient, { name: 'search' }))
      }

      for (const startChannel of agentsMcpServerCallChannels) {
        it(`reads the server object of the call on ${startChannel.name}`, async () => {
          await startChannel.runStores({ self: { name: 'local-files' } }, () => callTool(stdio(), { name: 'search' }))

          assert.strictEqual(evaluate.firstCall.args[1][MCP_SERVERS][0].name, 'local-files')
        })
      }

      it('keeps the configured name out of a later direct call', async () => {
        const client = stdio()

        await callFromAgent(client, { name: 'local-files' })
        await callTool(client, { name: 'search' })

        const names = evaluate.getCalls().map(call => call.args[1][MCP_SERVERS][0].name)
        assert.deepStrictEqual(names, ['local-files', undefined])
      })

      it('adds the configured name to the server entry', async () => {
        await callFromAgent(stdio(), { name: 'local-files' })

        assert.deepStrictEqual(evaluate.firstCall.args[1][MCP_SERVERS], [{
          id: serverId('stdio|npx|pkg'),
          managed_by: 'client',
          transport: 'stdio',
          name: 'local-files',
          command: 'npx',
          args: ['pkg'],
          tools: { search: 'search' },
        }])
      })

      for (const name of ['stdio: npx -y pkg --token secret', 'sse: https://user:pass@x/sse', 'streamable-http: x', '']) {
        it(`drops the name ${JSON.stringify(name)}`, async () => {
          await callFromAgent(stdio(), { name })

          assert.strictEqual(Object.hasOwn(evaluate.firstCall.args[1][MCP_SERVERS][0], 'name'), false)
        })
      }

      it('uses the name in the ID only when no URL or command identifies the server', async () => {
        await callFromAgent(createClient({ type: 'in_process' }), { name: 'atlassian' })

        assert.strictEqual(evaluate.firstCall.args[1][MCP_SERVERS][0].id, 'mcp_4b1df2a2d821278c')
      })

      it('keeps one entry for each name on the same transport', async () => {
        const client = stdio()

        await callFromAgent(client, { name: 'first' })
        await callTool(client, { name: 'search' })
        await callFromAgent(client, { name: 'second' })

        const names = evaluate.getCalls().map(call => call.args[1][MCP_SERVERS][0].name)
        assert.deepStrictEqual(names, ['first', undefined, 'second'])
      })

      it('fails open when the name getter throws', async () => {
        await callFromAgent(stdio(), { get name () { throw new Error('closed') } })

        assert.strictEqual(Object.hasOwn(evaluate.firstCall.args[1][MCP_SERVERS][0], 'name'), false)
      })

      it('unbinds the store when the integration is disabled', () => {
        assert.ok(agentsMcpServerCallChannels.every(startChannel => startChannel.hasSubscribers))

        mcp.disable()

        assert.ok(agentsMcpServerCallChannels.every(startChannel => !startChannel.hasSubscribers))
      })
    })

    it('unsubscribes when the integration is disabled', () => {
      mcp.disable()

      assert.strictEqual(callToolInterceptChannel.hasSubscribers, false)
      assert.strictEqual(listToolsResultChannel.hasSubscribers, false)
    })
  })

  describe('model request correlation', () => {
    const mcpServer = {
      id: REMOTE_SERVER_ID,
      managed_by: 'client',
      url: 'https://mcp.example.com',
      transport: 'streamable_http',
    }

    let remote

    beforeEach(() => {
      openai.enable({ evaluate }, true, true, true)
      remote = createClient({ type: 'streamable_http', url: new URL(REMOTE_URL) })
    })

    /**
     * Publishes an OpenAI chat completions intercept inside the given trace.
     *
     * @param {object} params
     * @param {object} requestSpan
     */
    function interceptChat (params, requestSpan) {
      const ctx = { arguments: [params], tracingContext: { currentStore: { span: requestSpan } } }
      chatCompletionsInterceptChannel.publish(ctx)
      return ctx
    }

    /**
     * @param {object} params
     * @param {object} requestSpan
     */
    function interceptResponses (params, requestSpan) {
      const ctx = { arguments: [params], tracingContext: { currentStore: { span: requestSpan } } }
      responsesInterceptChannel.publish(ctx)
      return ctx
    }

    /**
     * @param {string} name
     * @param {object} schema
     */
    function chatTool (name, schema) {
      return { type: 'function', function: { name, parameters: schema } }
    }

    /**
     * @param {string} name
     * @param {string} args
     * @param {string} [id]
     */
    function chatBody (name, args, id = 'call_model') {
      return {
        choices: [{
          message: { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
        }],
      }
    }

    function mcpEvaluations () {
      return evaluate.getCalls().filter(call => call.args[1][MCP_SERVERS])
    }

    it('attaches the server to the model tool call and skips the later callTool check', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const params = { messages: [{ role: 'user', content: 'Find x' }], tools: [chatTool('search', tool.inputSchema)] }
      const body = chatBody('search', '{ "q": "x" }')
      const ctx = interceptChat(params, span())

      assert.strictEqual(await ctx.onResult(body), body)

      sinon.assert.calledOnce(evaluate)
      assert.deepStrictEqual(evaluate.firstCall.args[0], [
        { role: 'user', content: 'Find x' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_model',
            type: 'function',
            function: { name: 'search', arguments: '{ "q": "x" }' },
            mcp: { server_id: REMOTE_SERVER_ID },
          }],
        },
      ])
      assert.deepStrictEqual(evaluate.firstCall.args[1][MCP_SERVERS], [{ ...mcpServer, tools: { search: 'search' } }])

      assert.strictEqual(await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root), undefined)
      sinon.assert.calledOnce(evaluate)

      // The mark is gone: a second call with the same arguments gets its own check.
      await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root)
      sinon.assert.calledTwice(evaluate)
    })

    it('starts a marked call at once with a copy of the params', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
      }, span())
      await ctx.onResult(chatBody('search', '{"q":"x"}'))
      const params = { name: 'search', arguments: { q: 'x' } }
      const callCtx = { ...remote, arguments: [params] }
      callToolInterceptChannel.publish(callCtx)

      const pending = legacyStorage.run({ span: root }, () => callCtx.beforeCall?.())

      assert.strictEqual(pending, undefined)
      sinon.assert.calledOnce(evaluate)
      assert.notStrictEqual(callCtx.arguments[0], params)
      assert.deepStrictEqual(callCtx.arguments[0], { name: 'search', arguments: { q: 'x' } })
    })

    it('skips the later check when validation changes the key order of the arguments', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
      }, span())
      await ctx.onResult(chatBody('search', '{"q":"x","limit":{"max":2,"min":1}}'))

      assert.strictEqual(
        await callTool(remote, { name: 'search', arguments: { limit: { min: 1, max: 2 }, q: 'x' } }, root),
        undefined
      )
      sinon.assert.calledOnce(evaluate)
    })

    it('never links a hosted MCP call that has the name of a linked function tool', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const ctx = interceptResponses({
        input: [
          { role: 'user', content: 'Find x' },
          { type: 'mcp_call', id: 'mcp_old', name: 'search', server_label: 'hosted', arguments: '{"q":"old"}' },
        ],
        tools: [
          { type: 'function', name: 'search', parameters: tool.inputSchema },
          { type: 'mcp', server_label: 'hosted', server_url: 'https://hosted.example.com/mcp' },
        ],
      }, span())
      const response = {
        output: [
          { type: 'mcp_call', id: 'mcp_1', name: 'search', server_label: 'hosted', arguments: '{"q":"hosted"}' },
          { type: 'function_call', call_id: 'call_f', name: 'search', arguments: '{"q":"local"}' },
        ],
      }

      await ctx.beforeResult()
      await ctx.onResult(response)

      const toolCalls = evaluate.secondCall.args[0].flatMap(message => message.tool_calls ?? [])
      assert.deepStrictEqual(toolCalls.map(toolCall => [toolCall.id, toolCall.mcp]), [
        ['mcp_old', undefined],
        ['mcp_1', undefined],
        ['call_f', { server_id: REMOTE_SERVER_ID }],
      ])
      assert.strictEqual(evaluate.firstCall.args[0][1].tool_calls[0].mcp, undefined)
      assert.strictEqual(Object.getOwnPropertySymbols(evaluate.firstCall.args[1]).length, 0)

      // Only the function call has a mark. The call with the arguments of the hosted call gets its own check.
      assert.strictEqual(await callTool(remote, { name: 'search', arguments: { q: 'local' } }, root), undefined)
      await callTool(remote, { name: 'search', arguments: { q: 'hosted' } }, root)
      sinon.assert.calledThrice(evaluate)
    })

    it('links a chat completions tool call that has a function but no type', async () => {
      const [tool] = listTools(remote, ['search'])
      const { span } = createTrace()
      const ctx = interceptChat({
        messages: [
          { role: 'user', content: 'Find x' },
          { role: 'assistant', tool_calls: [{ id: 'call_untyped', function: { name: 'search', arguments: '{}' } }] },
        ],
        tools: [chatTool('search', tool.inputSchema)],
      }, span())

      await ctx.beforeResult()

      assert.deepStrictEqual(evaluate.firstCall.args[0][1].tool_calls[0].mcp, { server_id: REMOTE_SERVER_ID })
    })

    it('links only the chat completions tool calls of function tools', async () => {
      const [tool] = listTools(remote, ['search'])
      const { span } = createTrace()
      const ctx = interceptChat({
        messages: [
          { role: 'user', content: 'Find x' },
          { role: 'assistant', tool_calls: [{ id: 'call_custom', type: 'custom', function: { name: 'search' } }] },
        ],
        tools: [chatTool('search', tool.inputSchema)],
      }, span())

      await ctx.beforeResult()

      assert.strictEqual(evaluate.firstCall.args[0][1].tool_calls[0].mcp, undefined)
      assert.strictEqual(Object.getOwnPropertySymbols(evaluate.firstCall.args[1]).length, 0)
    })

    it('evaluates a later call that has other arguments, another client or another trace', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const other = createClient(remote.transportInfo)
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
      }, span())
      await ctx.onResult(chatBody('search', '{"q":"x"}'))

      await callTool(remote, { name: 'search', arguments: { q: 'y' } }, root)
      await callTool(other, { name: 'search', arguments: { q: 'x' } }, root)
      await callTool(remote, { name: 'search', arguments: { q: 'x' } }, createTrace().root)
      await callTool(remote, { name: 'search', arguments: { q: 'x' } })

      assert.strictEqual(mcpEvaluations().length, 5)
    })

    for (const [description, outcome] of [
      ['a blocked response', new AIGuardAbortError('blocked', [], {}, [])],
      ['a failed response evaluation', new Error('unavailable')],
    ]) {
      it(`makes no marks for ${description}`, async () => {
        const [tool] = listTools(remote, ['search'])
        const { root, span } = createTrace()
        evaluate.onFirstCall().rejects(outcome)
        const ctx = interceptChat({
          messages: [{ role: 'user', content: 'Find x' }],
          tools: [chatTool('search', tool.inputSchema)],
        }, span())

        await ctx.onResult(chatBody('search', '{"q":"x"}')).catch(() => {})
        await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root)

        assert.strictEqual(mcpEvaluations().length, 2)
      })
    }

    it('marks the tool calls of a monitored response', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      evaluate.onFirstCall().resolves({ action: 'DENY', reason: 'monitored' })
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
      }, span())

      await ctx.onResult(chatBody('search', '{"q":"x"}'))

      assert.strictEqual(await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root), undefined)
      sinon.assert.calledOnce(evaluate)
    })

    it('maps a converted model name to the original tool of each client', async () => {
      const github = createClient({ type: 'streamable_http', url: new URL('https://github.example.com/mcp') })
      const jira = createClient({ type: 'stdio', command: 'uvx', args: ['mcp-example'] })
      const [githubSearch] = listTools(github, ['search'])
      const [jiraSearch] = listTools(jira, ['search'])
      const { root, span } = createTrace()
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('github__search', githubSearch.inputSchema), chatTool('jira-search', jiraSearch.inputSchema)],
      }, span())
      const body = {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'github__search', arguments: '{"q":"x"}' } },
              { id: 'call_2', type: 'function', function: { name: 'jira-search', arguments: '{"q":"x"}' } },
            ],
          },
        }],
      }

      await ctx.onResult(body)

      const [messages, opts] = evaluate.firstCall.args
      const githubId = serverId('url|https://github.example.com')
      assert.deepStrictEqual(messages[1].tool_calls.map(toolCall => toolCall.mcp.server_id), [
        githubId,
        'mcp_0f2f11f8cafdbcc5',
      ])
      assert.deepStrictEqual(opts[MCP_SERVERS].map(server => [server.id, server.tools]), [
        [githubId, { github__search: 'search' }],
        ['mcp_0f2f11f8cafdbcc5', { 'jira-search': 'search' }],
      ])

      // Each client consumes its own mark.
      assert.strictEqual(await callTool(jira, { name: 'search', arguments: { q: 'x' } }, root), undefined)
      assert.strictEqual(await callTool(github, { name: 'search', arguments: { q: 'x' } }, root), undefined)
      sinon.assert.calledOnce(evaluate)
    })

    it('falls back to the callTool check for cloned schemas', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const params = {
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', structuredClone(tool.inputSchema))],
      }
      const ctx = interceptChat(params, span())

      await ctx.beforeResult()
      await ctx.onResult(chatBody('search', '{"q":"x"}'))
      await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root)

      sinon.assert.calledThrice(evaluate)
      assert.strictEqual(Object.getOwnPropertySymbols(evaluate.firstCall.args[1]).length, 0)
      assert.strictEqual(Object.getOwnPropertySymbols(evaluate.secondCall.args[1]).length, 0)
      assert.strictEqual(evaluate.secondCall.args[0][1].tool_calls[0].mcp, undefined)
      assert.strictEqual(mcpEvaluations().length, 1)
    })

    it('leaves the evaluations generic when the model request is the root of its trace', async () => {
      const [tool] = listTools(remote, ['search'])
      const trace = { started: /** @type {object[]} */ ([]) }
      const requestSpan = { context: () => ({ _trace: trace }) }
      trace.started.push(requestSpan)
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
      }, requestSpan)

      await ctx.onResult(chatBody('search', '{"q":"x"}'))
      await callTool(remote, { name: 'search', arguments: { q: 'x' } })

      sinon.assert.calledTwice(evaluate)
      assert.strictEqual(evaluate.firstCall.args[0][1].tool_calls[0].mcp, undefined)
      assert.strictEqual(mcpEvaluations().length, 1)
    })

    it('attaches the servers of the MCP tool calls in the input history', async () => {
      const [tool] = listTools(remote, ['search'])
      const { span } = createTrace()
      const history = {
        role: 'assistant',
        tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
      }
      const params = {
        messages: [
          { role: 'user', content: 'Find x' },
          history,
          { role: 'tool', tool_call_id: 'call_old', content: 'x' },
        ],
        tools: [chatTool('search', tool.inputSchema)],
      }
      const snapshot = structuredClone(params)
      const ctx = interceptChat(params, span())

      await ctx.beforeResult()

      const [messages, opts] = evaluate.firstCall.args
      assert.deepStrictEqual(messages[1].tool_calls[0].mcp, { server_id: REMOTE_SERVER_ID })
      assert.deepStrictEqual(opts, {
        ...OPENAI_OPTS,
        childOf: ctx.tracingContext.currentStore.span,
        [MCP_SERVERS]: [{ ...mcpServer, tools: { search: 'search' } }],
      })
      assert.deepStrictEqual(params, snapshot)
      assert.strictEqual(params.messages[1], history)
    })

    it('keeps the request and the response of the application unchanged', async () => {
      const [tool] = listTools(remote, ['search'])
      const { span } = createTrace()
      const params = { messages: [{ role: 'user', content: 'Find x' }], tools: [chatTool('search', tool.inputSchema)] }
      const body = chatBody('search', '{"q":"x"}')
      const paramsSnapshot = structuredClone(params)
      const bodySnapshot = structuredClone(body)
      const ctx = interceptChat(params, span())

      await ctx.beforeResult()
      await ctx.onResult(body)

      assert.deepStrictEqual(params, paramsSnapshot)
      assert.deepStrictEqual(body, bodySnapshot)
      assert.strictEqual(params.tools[0].function.parameters, tool.inputSchema)
    })

    it('marks the tool calls of a streamed chat completion that it analyzes', async () => {
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
        stream: true,
      }, span())
      const chunks = [
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'search', arguments: '' } }],
            },
          }],
        },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] } }] },
      ]

      await ctx.onResult(new FakeStream(chunks))

      assert.deepStrictEqual(evaluate.firstCall.args[0][1].tool_calls[0].mcp, { server_id: REMOTE_SERVER_ID })
      assert.strictEqual(await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root), undefined)
      sinon.assert.calledOnce(evaluate)
    })

    it('leaves the check to callTool when streamed responses are not analyzed', async () => {
      openai.disable()
      openai.enable({ evaluate }, true, false, true)
      const [tool] = listTools(remote, ['search'])
      const { root, span } = createTrace()
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
        stream: true,
      }, span())

      assert.strictEqual(ctx.onResult, undefined)
      await ctx.beforeResult()
      await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root)

      sinon.assert.calledTwice(evaluate)
      assert.strictEqual(mcpEvaluations().length, 1)
    })

    for (const stream of [false, true]) {
      it(`marks the function calls of a ${stream ? 'streamed ' : ''}Responses API output`, async () => {
        const [tool] = listTools(remote, ['search'])
        const { root, span } = createTrace()
        const params = {
          input: 'Find x',
          tools: [{ type: 'function', name: 'srv_search', parameters: tool.inputSchema }],
          stream,
        }
        const response = {
          output: [{ type: 'function_call', call_id: 'call_r', name: 'srv_search', arguments: '{"q":"x"}' }],
        }
        const ctx = interceptResponses(params, span())

        await ctx.onResult(stream ? new FakeStream([{ type: 'response.completed', response }]) : response)

        const [messages, opts] = evaluate.firstCall.args
        assert.deepStrictEqual(messages[1], {
          role: 'assistant',
          tool_calls: [{
            id: 'call_r',
            function: { name: 'srv_search', arguments: '{"q":"x"}' },
            mcp: { server_id: REMOTE_SERVER_ID },
          }],
        })
        assert.deepStrictEqual(opts[MCP_SERVERS], [{ ...mcpServer, tools: { srv_search: 'search' } }])
        assert.strictEqual(await callTool(remote, { name: 'search', arguments: { q: 'x' } }, root), undefined)
        sinon.assert.calledOnce(evaluate)
      })
    }

    it('links no tool when the MCP kill switch is off', async () => {
      openai.disable()
      openai.enable({ evaluate }, true, true, false)
      const [tool] = listTools(remote, ['search'])
      const { span } = createTrace()
      const ctx = interceptChat({
        messages: [{ role: 'user', content: 'Find x' }],
        tools: [chatTool('search', tool.inputSchema)],
      }, span())

      await ctx.onResult(chatBody('search', '{"q":"x"}'))

      assert.strictEqual(evaluate.firstCall.args[0][1].tool_calls[0].mcp, undefined)
      assert.strictEqual(Object.getOwnPropertySymbols(evaluate.firstCall.args[1]).length, 0)
    })
  })
})
