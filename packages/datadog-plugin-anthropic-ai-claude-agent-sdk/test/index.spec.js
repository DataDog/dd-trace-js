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
          assert.equal(span.metrics['anthropic.agent.num_turns'], 2)
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
    })
  })
})
