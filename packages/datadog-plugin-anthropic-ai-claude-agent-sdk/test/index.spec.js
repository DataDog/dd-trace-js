'use strict'

const assert = require('node:assert/strict')
const { describe, before, after, it } = require('mocha')
const { tracingChannel, channel } = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const queryChannel = tracingChannel('apm:anthropic-ai-claude-agent-sdk:query')
const messageChannel = channel('apm:anthropic-ai-claude-agent-sdk:message')

/**
 * Drive the diagnostic channels the way the instrumentation does, so the plugin
 * goes through its full lifecycle (start → message stream → asyncEnd). The
 * Claude CLI subprocess is not available in the test environment, so we
 * simulate the SDKMessage stream that the real `query()` async generator
 * would emit.
 *
 * @param {object} options
 * @param {object} options.startCtx - The ctx passed to the start channel.
 * @param {Array<object>} options.messages - SDKMessage values to emit before
 *   asyncEnd. The last message is treated as the result (set as ctx.result).
 * @param {Error} [options.error] - When provided, publishes on the error
 *   channel before asyncEnd.
 */
function simulateQuery ({ startCtx, messages = [], error }) {
  queryChannel.start.runStores(startCtx, () => {
    queryChannel.end.publish(startCtx)

    for (const message of messages) {
      messageChannel.publish({ ctx: startCtx, message })
      if (message.type === 'result') {
        startCtx.result = message
      }
    }

    if (error) {
      startCtx.error = error
      queryChannel.error.publish(startCtx)
    }

    queryChannel.asyncEnd.publish(startCtx)
  })
}

function buildResultMessage (overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 2,
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0.000123,
    session_id: 'sess-abc-123',
    terminal_reason: 'completed',
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 10,
    },
    ...overrides,
  }
}

function buildInitMessage (overrides = {}) {
  return {
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-5',
    session_id: 'sess-abc-123',
    apiKeySource: 'user',
    claude_code_version: '2.1.143',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'uuid-1',
    ...overrides,
  }
}

describe('Plugin', () => {
  withVersions('anthropic-ai-claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', (version) => {
    before(async () => {
      await agent.load('anthropic-ai-claude-agent-sdk')

      // Trigger the instrumentation hook so the plugin registers itself.
      // Loading the wrapper module pulls in the real ESM package via
      // dd-trace's require-hook, which fires `addHook` and registers the
      // plugin under its static id.
      require(`../../../versions/@anthropic-ai/claude-agent-sdk@${version}`).get()
    })

    after(async () => {
      await agent.close({ ritmReset: false })
    })

    describe('query() span', () => {
      it('creates a basic query span with component and span.kind=client', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.name, 'anthropic.agent.query')
          assert.equal(span.resource, 'query')
          assert.equal(span.meta.component, '@anthropic-ai/claude-agent-sdk')
          assert.equal(span.meta['span.kind'], 'client')
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-sonnet-4-5' } },
          messages: [buildResultMessage()],
        })

        await tracesPromise
      })

      it('tags anthropic.request.model from options.model', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.meta['anthropic.request.model'], 'claude-opus-4-1')
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-opus-4-1' } },
          messages: [buildResultMessage()],
        })

        await tracesPromise
      })

      it('falls back to the model from SDKSystemMessage when options.model is absent', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.meta['anthropic.request.model'], 'claude-sonnet-4-5')
        })

        simulateQuery({
          startCtx: { resource: 'query', options: {} },
          messages: [
            buildInitMessage({ model: 'claude-sonnet-4-5' }),
            buildResultMessage(),
          ],
        })

        await tracesPromise
      })

      it('does not override options.model with the init message model', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.meta['anthropic.request.model'], 'claude-opus-4-1')
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-opus-4-1' } },
          messages: [
            buildInitMessage({ model: 'claude-sonnet-4-5' }),
            buildResultMessage(),
          ],
        })

        await tracesPromise
      })

      it('tags usage and agent metadata from the SDKResultMessage', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.meta['anthropic.agent.session_id'], 'sess-abc-123')
          assert.equal(span.meta['anthropic.agent.terminal_reason'], 'completed')
          assert.equal(span.meta['anthropic.response.stop_reason'], 'end_turn')
          assert.equal(span.metrics['anthropic.agent.num_turns'], 2)
          assert.equal(span.metrics['anthropic.agent.duration_ms'], 1234)
          assert.equal(span.metrics['anthropic.agent.total_cost_usd'], 0.000123)
          assert.equal(span.metrics['anthropic.response.input_tokens'], 100)
          assert.equal(span.metrics['anthropic.response.output_tokens'], 25)
          assert.equal(span.metrics['anthropic.response.cache_read_input_tokens'], 5)
          assert.equal(span.metrics['anthropic.response.cache_creation_input_tokens'], 10)
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-sonnet-4-5' } },
          messages: [buildResultMessage()],
        })

        await tracesPromise
      })

      it('captures the full span shape (service, type, name, resource, meta, metrics)', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.name, 'anthropic.agent.query')
          assert.equal(span.resource, 'query')
          assert.equal(span.service, 'test')
          assert.equal(span.error, 0)

          assert.equal(span.meta.component, '@anthropic-ai/claude-agent-sdk')
          assert.equal(span.meta['span.kind'], 'client')
          assert.equal(span.meta['anthropic.request.model'], 'claude-sonnet-4-5')
          assert.equal(span.meta['anthropic.agent.session_id'], 'sess-abc-123')
          assert.equal(span.meta['anthropic.agent.terminal_reason'], 'completed')
          assert.equal(span.meta['anthropic.response.stop_reason'], 'end_turn')
          assert.equal(span.meta['anthropic.response.subtype'], 'success')

          assert.equal(span.metrics['anthropic.agent.num_turns'], 2)
          assert.equal(span.metrics['anthropic.agent.duration_ms'], 1234)
          assert.equal(span.metrics['anthropic.agent.total_cost_usd'], 0.000123)
          assert.equal(span.metrics['anthropic.response.input_tokens'], 100)
          assert.equal(span.metrics['anthropic.response.output_tokens'], 25)
          assert.equal(span.metrics['anthropic.response.cache_read_input_tokens'], 5)
          assert.equal(span.metrics['anthropic.response.cache_creation_input_tokens'], 10)
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-sonnet-4-5' } },
          messages: [buildResultMessage()],
        })

        await tracesPromise
      })

      it('marks the span as error when SDKResultMessage.is_error=true', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.error, 1)
          assert.equal(span.meta['anthropic.response.subtype'], 'error_max_turns')
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-sonnet-4-5' } },
          messages: [
            buildResultMessage({
              subtype: 'error_max_turns',
              is_error: true,
            }),
          ],
        })

        await tracesPromise
      })

      it('marks the span as error when subtype is error_during_execution', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.error, 1)
          assert.equal(span.meta['anthropic.response.subtype'], 'error_during_execution')
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-sonnet-4-5' } },
          messages: [
            buildResultMessage({
              subtype: 'error_during_execution',
              is_error: true,
            }),
          ],
        })

        await tracesPromise
      })

      it('marks the span as error and stores error tags when the generator throws', async () => {
        const error = new Error('subprocess crashed')

        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.error, 1)
          assert.equal(span.meta['error.message'], 'subprocess crashed')
        })

        simulateQuery({
          startCtx: { resource: 'query', options: { model: 'claude-sonnet-4-5' } },
          messages: [],
          error,
        })

        await tracesPromise
      })
    })

    describe('WarmQuery.query() span', () => {
      it('creates a span with resource=WarmQuery.query', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.name, 'anthropic.agent.query')
          assert.equal(span.resource, 'WarmQuery.query')
          assert.equal(span.meta['anthropic.request.model'], 'claude-sonnet-4-5')
          assert.equal(span.meta['anthropic.agent.session_id'], 'sess-abc-123')
        })

        simulateQuery({
          startCtx: { resource: 'WarmQuery.query', options: { model: 'claude-sonnet-4-5' } },
          messages: [buildResultMessage()],
        })

        await tracesPromise
      })

      it('marks the WarmQuery span as error when SDKResultMessage.is_error=true', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.resource, 'WarmQuery.query')
          assert.equal(span.error, 1)
          assert.equal(span.meta['anthropic.response.subtype'], 'error_max_turns')
        })

        simulateQuery({
          startCtx: { resource: 'WarmQuery.query', options: { model: 'claude-sonnet-4-5' } },
          messages: [
            buildResultMessage({
              subtype: 'error_max_turns',
              is_error: true,
            }),
          ],
        })

        await tracesPromise
      })

      it('marks the WarmQuery span as error when subtype is error_max_budget_usd', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.resource, 'WarmQuery.query')
          assert.equal(span.error, 1)
          assert.equal(span.meta['anthropic.response.subtype'], 'error_max_budget_usd')
        })

        simulateQuery({
          startCtx: { resource: 'WarmQuery.query', options: { model: 'claude-sonnet-4-5' } },
          messages: [
            buildResultMessage({
              subtype: 'error_max_budget_usd',
              is_error: true,
            }),
          ],
        })

        await tracesPromise
      })

      it('marks the WarmQuery span as error and stores error tags when the generator throws', async () => {
        const error = new Error('warm subprocess crashed')

        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.resource, 'WarmQuery.query')
          assert.equal(span.error, 1)
          assert.equal(span.meta['error.message'], 'warm subprocess crashed')
        })

        simulateQuery({
          startCtx: { resource: 'WarmQuery.query', options: { model: 'claude-sonnet-4-5' } },
          messages: [],
          error,
        })

        await tracesPromise
      })
    })

    describe('real package patching', () => {
      // The async generator returned by sdk.query() spawns a Claude CLI
      // subprocess that requires real credentials, so we cannot drain it in
      // a unit test. We verify instead that the exported sdk.query function
      // is non-null and callable after the require-hook fires — which proves
      // the addHook was registered and the module loaded successfully. Full
      // end-to-end coverage of the async-generator wrapping (wrapGenerator,
      // wrapStartup, wrapWarmQueryQuery) is provided via the
      // "shimmer-based wrapping" suite below, which invokes the registered
      // hook directly on a controlled mock module.
      it('loads the SDK through the dd-trace require-hook with query() callable', () => {
        const sdk = require(`../../../versions/@anthropic-ai/claude-agent-sdk@${version}`).get()
        assert.equal(typeof sdk.query, 'function', 'expected sdk.query to be exported and callable')
      })
    })

    describe('shimmer-based wrapping (mocked SDK, real hook)', () => {
      // The Claude CLI subprocess is not available in tests, so we cannot drain
      // a real `sdk.query()` async generator. Instead we look up the addHook
      // callback that dd-trace registered for `@anthropic-ai/claude-agent-sdk`
      // and invoke it directly on a fake `exports` object that mimics the real
      // module surface. This executes the real wrapQuery/wrapStartup/
      // wrapWarmQueryQuery/wrapGenerator code paths (including the next/return/
      // throw interceptors and the ctx.finished double-finish guard), with us
      // controlling what the underlying generator yields.
      const sym = Symbol.for('_ddtrace_instrumentations')

      function makeAsyncGenerator (messages, opts = {}) {
        return (async function * mockClaudeStream () {
          for (const m of messages) yield m
          if (opts.throwAfter) throw opts.throwAfter
        })()
      }

      function getHook () {
        const registry = globalThis[sym]
        const entries = registry?.['@anthropic-ai/claude-agent-sdk']
        assert.ok(entries && entries.length > 0, 'expected dd-trace to register an addHook for the SDK')
        const hook = entries[0].hook
        assert.equal(typeof hook, 'function', 'expected the registered entry to expose a hook function')
        return hook
      }

      it('drives wrapQuery + wrapGenerator: publishes start, message, asyncEnd; tags from result', async () => {
        const hook = getHook()
        const messages = [
          buildInitMessage({ model: 'claude-sonnet-4-5' }),
          buildResultMessage(),
        ]
        const fakeExports = {
          query: () => makeAsyncGenerator(messages),
          startup: () => Promise.resolve({ query: () => makeAsyncGenerator([]) }),
        }
        const wrapped = hook(fakeExports, '0.1.0', false) || fakeExports

        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.name, 'anthropic.agent.query')
          assert.equal(span.resource, 'query')
          assert.equal(span.meta.component, '@anthropic-ai/claude-agent-sdk')
          assert.equal(span.meta['span.kind'], 'client')
          assert.equal(span.meta['anthropic.request.model'], 'claude-sonnet-4-5')
          assert.equal(span.meta['anthropic.agent.session_id'], 'sess-abc-123')
          assert.equal(span.meta['anthropic.agent.terminal_reason'], 'completed')
          assert.equal(span.meta['anthropic.response.stop_reason'], 'end_turn')
          assert.equal(span.metrics['anthropic.agent.num_turns'], 2)
          assert.equal(span.metrics['anthropic.agent.duration_ms'], 1234)
          assert.equal(span.metrics['anthropic.response.input_tokens'], 100)
          assert.equal(span.metrics['anthropic.response.output_tokens'], 25)
        })

        const gen = wrapped.query({ prompt: 'hello', options: { model: 'claude-sonnet-4-5' } })
        for await (const _ of gen) { /* drain */ } // eslint-disable-line no-unused-vars

        await tracesPromise
      })

      it('drives wrapStartup + wrapWarmQueryQuery: WarmQuery.query span uses startup options', async () => {
        const hook = getHook()
        const fakeExports = {
          query: () => makeAsyncGenerator([]),
          startup: ({ options } = {}) => Promise.resolve({
            // eslint-disable-next-line no-unused-vars
            query: (_prompt) => makeAsyncGenerator([buildResultMessage()]),
          }),
        }
        const wrapped = hook(fakeExports, '0.1.0', false) || fakeExports

        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.name, 'anthropic.agent.query')
          assert.equal(span.resource, 'WarmQuery.query')
          assert.equal(span.meta.component, '@anthropic-ai/claude-agent-sdk')
          assert.equal(span.meta['span.kind'], 'client')
          assert.equal(span.meta['anthropic.request.model'], 'claude-opus-4-1')
          assert.equal(span.meta['anthropic.agent.session_id'], 'sess-abc-123')
          assert.equal(span.metrics['anthropic.agent.num_turns'], 2)
          assert.equal(span.metrics['anthropic.response.input_tokens'], 100)
        })

        const warm = await wrapped.startup({ options: { model: 'claude-opus-4-1' } })
        const gen = warm.query('hello')
        for await (const _ of gen) { /* drain */ } // eslint-disable-line no-unused-vars

        await tracesPromise
      })

      it('drives wrapGenerator throw path: tags span error when underlying generator rejects', async () => {
        const hook = getHook()
        const fakeExports = {
          query: () => makeAsyncGenerator([], { throwAfter: new Error('mock cli crashed') }),
        }
        const wrapped = hook(fakeExports, '0.1.0', false) || fakeExports

        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.equal(span.name, 'anthropic.agent.query')
          assert.equal(span.resource, 'query')
          assert.equal(span.error, 1)
          assert.equal(span.meta['error.message'], 'mock cli crashed')
          assert.equal(span.meta.component, '@anthropic-ai/claude-agent-sdk')
        })

        let caught
        try {
          const gen = wrapped.query({ prompt: 'hello', options: { model: 'claude-sonnet-4-5' } })
          for await (const _ of gen) { /* drain */ } // eslint-disable-line no-unused-vars
        } catch (e) {
          caught = e
        }
        assert.equal(caught?.message, 'mock cli crashed', 'wrapper must re-throw the underlying error')

        await tracesPromise
      })
    })
  })
})
