'use strict'

const assert = require('node:assert/strict')

const { describe, before, after, it } = require('mocha')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { supportsRunningNode } = require('./supports-running-node')

const MODEL = 'jev-1.13.0'
const STATE = 'I was charged twice for my subscription this month and want the duplicate refunded.'
const ERROR_STATE = 'Please cancel my account.'

describe('Plugin', () => {
  withVersions('typesafe', '@typesafe-ai/sdk', (version) => {
    if (!supportsRunningNode(require(`../../../versions/@typesafe-ai/sdk@${version}`))) return

    let sdk

    before(async () => {
      await agent.load('typesafe')
      sdk = require(`../../../versions/@typesafe-ai/sdk@${version}`).get()
    })

    after(() => agent.close())

    function createClient (apiKey = process.env.TYPESAFE_API_KEY ?? 'not-a-real-key') {
      return new sdk.TypeSafeClient({
        apiKey,
        baseURL: 'http://127.0.0.1:9126/vcr/typesafe',
        // 0.7.0 zstd-compresses request bodies of 1 KiB or more on Node.js 22.15+, which would make cassette bodies
        // unreadable and differ across Node.js versions
        compression: false,
        retry: { maxRetries: 0 },
      })
    }

    function questions () {
      return {
        team: sdk.choice('Which team should handle this message?', {
          billing: 'Charges, refunds, invoices',
          technical: 'Bugs, outages, errors',
          sales: 'Pricing, plans, buying more',
        }),
        refund: sdk.noul('Is the customer asking for a refund?'),
        urgency: sdk.score('How urgent is this message?', ['Low', 'Medium', 'High']),
      }
    }

    describe('systemOne', () => {
      it('creates a span', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'typesafe.request')
          assert.equal(span.resource, 'TypeSafeClient.systemOne')
          assert.equal(span.meta['typesafe.request.model'], MODEL)
          assert.equal(span.meta['typesafe.response.model'], MODEL)
          assert.equal(span.error, 0)
        })

        const promise = createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })

        assert.strictEqual(typeof promise.withResponse, 'function', 'Expected the SDK APIPromise to reach the caller')

        const result = await promise
        assert.ok(result.answers.team)

        await tracesPromise
      })

      it('leaves the raw response readable through asResponse()', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          assert.equal(traces[0][0].meta['typesafe.response.model'], MODEL)
        })

        const response = await createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })
          .asResponse()
        const body = await response.json()
        assert.equal(body.model, MODEL)

        await tracesPromise
      })

      it('records errors', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'typesafe.request')
          assert.equal(span.error, 1)
        })

        await assert.rejects(
          createClient('not-a-real-key').systemOne({ state: ERROR_STATE, questions: questions(), model: MODEL }),
          error => error instanceof sdk.AuthenticationError
        )

        await tracesPromise
      })

      it('records errors reading the response body', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'typesafe.request')
          assert.equal(span.error, 1)
          // The SDK buffers the body before asResponse() resolves, so the failure arrives as its connection error
          assert.equal(span.meta['error.message'], 'Connection error: connection reset')
        })

        const body = new ReadableStream({
          pull (controller) {
            controller.error(new Error('connection reset'))
          },
        })
        const client = new sdk.TypeSafeClient({
          apiKey: 'not-a-real-key',
          retry: { maxRetries: 0 },
          fetch: () => Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } })),
        })

        await assert.rejects(
          client.systemOne({ state: STATE, questions: questions(), model: MODEL }),
          error => error instanceof sdk.APIConnectionError
        )

        await tracesPromise
      })

      it('records validation errors raised before any request is sent', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          assert.equal(traces.length, 1)
          const span = traces[0][0]

          assert.equal(span.name, 'typesafe.request')
          assert.equal(span.error, 1)
          assert.equal(span.meta['error.type'], 'TypeSafeError')
        })

        await assert.rejects(
          async () => createClient().systemOne({ state: STATE, questions: {}, model: MODEL }),
          error => error instanceof sdk.TypeSafeError
        )

        await tracesPromise
      })
    })
  })
})
