'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const { promisify } = require('node:util')

const { channel } = require('dc-polyfill')
const { describe, before, after, it } = require('mocha')
const sinon = require('sinon')

const { anthropic: anthropicIntegration } = require('../../dd-trace/src/aiguard/integrations')
const log = require('../../dd-trace/src/log')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { useEnv } = require('../../../integration-tests/helpers')

const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

describe('Plugin', () => {
  useEnv({
    ANTHROPIC_API_KEY: '<not-a-real-key>',
  })

  withVersions('anthropic', '@anthropic-ai/sdk', (version) => {
    let Anthropic
    let client
    let malformedResponseClient

    before(async () => {
      await agent.load('anthropic')

      Anthropic = require(`../../../versions/@anthropic-ai/sdk@${version}`).get().Anthropic
      client = new Anthropic({ baseURL: 'http://127.0.0.1:9126/vcr/anthropic' })
      malformedResponseClient = new Anthropic({
        fetch: async () => new Response('not json', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      })
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

      it('finishes a raw response through the AI Guard lifecycle before its body is consumed', async () => {
        const evaluate = sinon.stub().resolves()
        anthropicIntegration.enable({ evaluate }, true)

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

          const expectedEvaluationCount = typeof response.body?.pipe === 'function' ? 1 : 2
          assert.strictEqual(evaluate.callCount, expectedEvaluationCount)
          assert.deepStrictEqual(evaluate.firstCall.args[0], [{ role: 'user', content: 'Hello, world!' }])
          if (expectedEvaluationCount === 2) {
            const outputMessages = evaluate.secondCall.args[0]
            assert.strictEqual(outputMessages[0].role, 'user')
            assert.strictEqual(outputMessages[1].role, 'assistant')
          }
          assert.strictEqual(response.bodyUsed, false)
          assert.ok(await response.json())
        } finally {
          anthropicIntegration.disable()
        }
      })

      it('does not report the parser-owned raw response read as an instrumentation error', async () => {
        const evaluate = sinon.stub().resolves()
        const logError = sinon.stub(log, 'error')
        anthropicIntegration.enable({ evaluate }, true)

        const tracesPromise = agent.assertSomeTraces(traces => {
          assert.strictEqual(traces[0][0].name, 'anthropic.request')
        })

        try {
          const resultPromise = client.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
          }).withResponse()
          const [result] = await Promise.all([resultPromise, tracesPromise])

          assert.strictEqual(result.data.role, 'assistant')
          assert.strictEqual(result.response.bodyUsed, true)
          sinon.assert.calledTwice(evaluate)
          sinon.assert.notCalled(logError)
        } finally {
          anthropicIntegration.disable()
          logError.restore()
        }
      })

      it('keeps raw response access independent from parsing failures', async () => {
        /** @param {{ pending: Promise<void>[] }} ctx */
        const onMessagesAfter = (ctx) => {
          ctx.pending.push(Promise.resolve())
        }
        messagesAfterChannel.subscribe(onMessagesAfter)

        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.strictEqual(span.error, 1)
        })
        const apiPromise = malformedResponseClient.messages.create({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
        })

        try {
          const [response] = await Promise.all([
            (async () => {
              await assert.rejects(apiPromise, SyntaxError)
              return apiPromise.asResponse()
            })(),
            tracesPromise,
          ])

          assert.strictEqual(response.status, 200)
        } finally {
          messagesAfterChannel.unsubscribe(onMessagesAfter)
        }
      })

      it('keeps a completed raw response span successful when parsing starts later', async () => {
        const evaluate = sinon.stub().resolves()
        anthropicIntegration.enable({ evaluate }, true)

        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.strictEqual(span.error, 0)
        })

        try {
          const apiPromise = malformedResponseClient.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
          })
          const responsePromise = apiPromise.asResponse()
          const [response] = await Promise.all([responsePromise, tracesPromise])

          sinon.assert.calledOnce(evaluate)
          assert.strictEqual(response.bodyUsed, false)
          assert.strictEqual(await response.clone().text(), 'not json')
          await assert.rejects(apiPromise, SyntaxError)
        } finally {
          anthropicIntegration.disable()
        }
      })

      if (version === '0.14.0') {
        it('fails open for node-fetch raw responses without consuming a clone', async () => {
          const text = 'x'.repeat(256 * 1024)
          const body = JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model: 'claude-3-7-sonnet-20250219',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          })
          const server = http.createServer(
            /**
             * @param {import('node:http').IncomingMessage} _request
             * @param {import('node:http').ServerResponse} response
             */
            (_request, response) => {
              response.writeHead(200, {
                'content-length': Buffer.byteLength(body),
                'content-type': 'application/json',
              })
              response.end(body)
            }
          )
          server.listen(0, '127.0.0.1')
          await once(server, 'listening')

          const address = server.address()
          const localClient = new Anthropic({
            apiKey: '<not-a-real-key>',
            baseURL: `http://127.0.0.1:${address.port}`,
          })
          let lifecycleCalls = 0
          /** @param {{ pending: Promise<void>[] }} ctx */
          const onMessagesAfter = (ctx) => {
            lifecycleCalls++
            ctx.pending.push(Promise.resolve())
          }
          messagesAfterChannel.subscribe(onMessagesAfter)

          const tracesPromise = agent.assertSomeTraces(
            /**
             * @param {Array<Array<{ name: string }>>} traces
             */
            traces => {
              assert.strictEqual(traces[0][0].name, 'anthropic.request')
            }
          )

          try {
            const responsePromise = localClient.messages.create({
              model: 'claude-3-7-sonnet-20250219',
              messages: [{ role: 'user', content: 'Hello, world!' }],
              max_tokens: 100,
            }).asResponse()
            const [response] = await Promise.all([responsePromise, tracesPromise])

            assert.strictEqual(response.bodyUsed, false)
            assert.strictEqual(lifecycleCalls, 0)
            assert.strictEqual((await response.json()).content[0].text.length, text.length)
          } finally {
            messagesAfterChannel.unsubscribe(onMessagesAfter)
            await promisify(server.close.bind(server))()
          }
        })
      }

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
