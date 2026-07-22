'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { describe, before, after, it } = require('mocha')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { useEnv } = require('../../../integration-tests/helpers')

const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

describe('Plugin', () => {
  useEnv({
    ANTHROPIC_API_KEY: '<not-a-real-key>',
  })

  withVersions('anthropic', '@anthropic-ai/sdk', (version) => {
    let client

    before(async () => {
      await agent.load('anthropic')

      const { Anthropic } = require(`../../../versions/@anthropic-ai/sdk@${version}`).get()
      client = new Anthropic({ baseURL: 'http://127.0.0.1:9126/vcr/anthropic' })
    })

    after(() => agent.close())

    describe('messages.create', () => {
      it('creates a span', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'anthropic.request')
          assert.equal(span.resource, 'Messages.create')
          assert.equal(span.meta['anthropic.request.model'], 'claude-3-7-sonnet-20250219')
        })

        const promise = client.messages.create({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        assert.strictEqual(
          typeof promise.withResponse, 'function',
          'Expected custom Anthropic APIPromise to have a withResponse method',
        )

        const result = await promise
        assert.ok(result)

        await tracesPromise
      })

      it('finishes a raw response before its body is consumed', async () => {
        const lifecycleCalls = []
        /** @param {{ pending: Promise<void>[] }} ctx */
        const onMessagesAfter = (ctx) => {
          lifecycleCalls.push(ctx)
          ctx.pending.push(Promise.resolve())
        }
        messagesAfterChannel.subscribe(onMessagesAfter)

        const tracesPromise = agent.assertSomeTraces(
          /**
           * @param {Array<Array<{ name: string }>>} traces
           */
          traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'anthropic.request')
          }
        )

        try {
          const responsePromise = client.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
          }).asResponse()
          const [response] = await Promise.all([responsePromise, tracesPromise])

          assert.strictEqual(lifecycleCalls.length, 1)
          assert.strictEqual(response.bodyUsed, false)
          assert.ok(await response.json())
        } finally {
          messagesAfterChannel.unsubscribe(onMessagesAfter)
        }
      })

      describe('stream', () => {
        it('creates a span', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'anthropic.request')
            assert.equal(span.resource, 'Messages.create')
            assert.equal(span.meta['anthropic.request.model'], 'claude-3-7-sonnet-20250219')
          })

          const promise = client.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
            stream: true,
          })

          assert.strictEqual(
            typeof promise.withResponse, 'function',
            'Expected custom Anthropic APIPromise to have a withResponse method',
          )

          const stream = await promise
          for await (const chunk of stream) {
            assert.ok(chunk)
          }

          await tracesPromise
        })
      })
    })

    describe('messages.stream', () => {
      it('creates a span for async iterator consumption', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'anthropic.request')

          // even though we're streaming, it calls Messages.create under the hood
          assert.equal(span.resource, 'Messages.create')

          assert.equal(span.meta['anthropic.request.model'], 'claude-3-7-sonnet-20250219')
        })

        const stream = client.messages.stream({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        for await (const chunk of stream) {
          assert.ok(chunk)
        }

        await tracesPromise
      })

      describe('when using streaming helper methods', () => {
        it('creates a span for stream.on', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'anthropic.request')
            assert.equal(span.resource, 'Messages.create')
            assert.equal(span.meta['anthropic.request.model'], 'claude-3-7-sonnet-20250219')
          })

          client.messages.stream({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
          }).on('text', text => {
            assert.ok(text)
          })

          await tracesPromise
        })

        it('creates a span for stream.finalMessage', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'anthropic.request')
            assert.equal(span.resource, 'Messages.create')
            assert.equal(span.meta['anthropic.request.model'], 'claude-3-7-sonnet-20250219')
          })

          const stream = client.messages.stream({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
            stream: true,
          })

          const message = await stream.finalMessage()
          assert.ok(message)

          await tracesPromise
        })
      })
    })
  })
})
