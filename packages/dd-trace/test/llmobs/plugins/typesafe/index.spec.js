'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const { describe, before, it } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { useLlmObs, MOCK_STRING, assertLlmObsSpanEvent } = require('../../util')
const { supportsRunningNode } = require('../../../../../datadog-plugin-typesafe/test/supports-running-node')

const MODEL = 'jev-1.13.0'
const STATE = 'I was charged twice for my subscription this month and want the duplicate refunded.'
// Distinct from STATE so the error request gets its own cassette
const ERROR_STATE = 'Please cancel my account.'
const EXPECTED_QUESTIONS = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this message?',
    criteria: {
      billing: 'Charges, refunds, invoices',
      technical: 'Bugs, outages, errors',
      sales: 'Pricing, plans, buying more',
    },
  },
  refund: { type: 'noul', instructions: 'Is the customer asking for a refund?' },
  urgency: { type: 'score', instructions: 'How urgent is this message?', criteria: ['Low', 'Medium', 'High'] },
}
// The response bodies exactly as recorded, which is what the span's output records
const STRING_STATE_RESPONSE = recordedResponse('typesafe_v1_systemone_post_8e45a9dd.json')
const JSON_STATE_RESPONSE = recordedResponse('typesafe_v1_systemone_post_3b431e67.json')
const STRING_STATE_METRICS = { input_tokens: 403, output_tokens: 69, total_tokens: 472 }
const JSON_STATE_METRICS = { input_tokens: 417, output_tokens: 69, total_tokens: 486 }
const STUB_RESPONSE = {
  model: MODEL,
  answers: { damaged: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 1 },
}
const IMAGE_REFERENCE = '<image:[0-9a-f]{32}>'

/**
 * @param {string} cassette
 */
function recordedResponse (cassette) {
  const file = path.join(__dirname, '..', '..', 'cassettes', 'typesafe', cassette)
  return JSON.parse(readFileSync(file, 'utf8')).response.body
}

/**
 * The JSON body the SDK sends for a request with the default questions.
 *
 * @param {unknown} state
 * @param {object} [questions]
 */
function requestBody (state, questions = EXPECTED_QUESTIONS) {
  return JSON.stringify({ state, questions, model: MODEL })
}

describe('Plugin', () => {
  const { getEvents } = useLlmObs({ plugin: 'typesafe' })

  withVersions('typesafe', '@typesafe-ai/sdk', (version) => {
    if (!supportsRunningNode(require(`../../../../../../versions/@typesafe-ai/sdk@${version}`))) return

    let sdk

    before(() => {
      sdk = require(`../../../../../../versions/@typesafe-ai/sdk@${version}`).get()
    })

    function createClient (apiKey = process.env.TYPESAFE_API_KEY ?? 'not-a-real-key', options = {}) {
      return new sdk.TypeSafeClient({
        ...options,
        apiKey,
        baseURL: 'http://127.0.0.1:9126/vcr/typesafe',
        // 0.7.0 zstd-compresses request bodies of 1 KiB or more on Node.js 22.15+, which would make cassette bodies
        // unreadable and differ across Node.js versions
        compression: false,
        retry: { maxRetries: 0 },
      })
    }

    // Requests with image assets are multipart with a random boundary and random image references, so a
    // cassette keyed on the request body cannot replay them; these tests answer from a canned response instead.
    function createStubbedClient (options = {}, body = JSON.stringify(STUB_RESPONSE)) {
      return new sdk.TypeSafeClient({
        ...options,
        apiKey: 'not-a-real-key',
        retry: { maxRetries: 0 },
        fetch: () => Promise.resolve(new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })),
      })
    }

    function questions () {
      const { team, refund, urgency } = EXPECTED_QUESTIONS
      return {
        team: sdk.choice(team.instructions, team.criteria),
        refund: sdk.noul(refund.instructions),
        urgency: sdk.score(urgency.instructions, urgency.criteria),
      }
    }

    function assertSystemOneSpan (apmSpan, llmobsSpan, { content, output, metrics }) {
      assertLlmObsSpanEvent(llmobsSpan, {
        span: apmSpan,
        spanKind: 'llm',
        name: 'typesafe.request',
        modelName: MODEL,
        modelProvider: 'typesafe',
        inputMessages: [{ role: 'user', content }],
        outputMessages: [{ role: 'assistant', content: output }],
        metrics,
        tags: { ml_app: 'test', integration: 'typesafe', decision_provider: 'typesafe' },
      })
    }

    describe('systemOne', () => {
      it('creates a span', async () => {
        await createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('serializes JSON state', async () => {
        const state = { message: STATE, plan: 'pro' }
        await createClient().systemOne({ state, questions: questions(), model: MODEL })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(state),
          output: JSON_STATE_RESPONSE,
          metrics: JSON_STATE_METRICS,
        })
      })

      it('captures the answers when the caller reads the raw response', async () => {
        const response = await createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })
          .asResponse()
        assert.equal((await response.json()).model, MODEL)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('captures the answers when the caller reads the raw response as text', async () => {
        const response = await createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })
          .asResponse()
        assert.equal(JSON.parse(await response.text()).model, MODEL)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('captures the answers when the caller reads a clone of the raw response', async () => {
        const response = await createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })
          .asResponse()
        assert.equal((await response.clone().json()).model, MODEL)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('captures the answers when the caller never awaits the request', async () => {
        createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('captures the answers when the caller uses withResponse()', async () => {
        const { data, response } = await createClient()
          .systemOne({ state: STATE, questions: questions(), model: MODEL })
          .withResponse()
        assert.equal(data.model, MODEL)
        assert.equal(response.status, 200)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('captures the answers when the caller uses map()', async () => {
        const team = await createClient()
          .systemOne({ state: STATE, questions: questions(), model: MODEL })
          .map(result => result.answers.team.choice)
        assert.equal(team, 'billing')

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('traces only systemOne, not other SDK calls', async () => {
        const client = createStubbedClient()
        await client.systemOne({ state: STATE, questions: questions(), model: MODEL }).map(result => result.model)
        await client.models.list().catch(() => {})

        const { apmSpans, llmobsSpans } = await getEvents()
        assert.equal(apmSpans.filter(span => span.name === 'typesafe.request').length, 1)
        assert.equal(llmobsSpans.length, 1)
      })

      it('uses the client default model when the request has none', async () => {
        // The SDK fills in defaultModel before sending, so this replays the same cassette as 'creates a span'
        await createClient(undefined, { defaultModel: MODEL }).systemOne({ state: STATE, questions: questions() })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: requestBody(STATE),
          output: STRING_STATE_RESPONSE,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('reports OpenRouter as the provider when the client points at OpenRouter', async () => {
        await createStubbedClient({ baseURL: 'https://openrouter.ai/api' })
          .systemOne({ state: STATE, questions: questions(), model: MODEL })

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans[0].meta.model_provider, 'openrouter')
      })

      it('records errors', async () => {
        let caught
        await assert.rejects(
          createClient('not-a-real-key').systemOne({ state: ERROR_STATE, questions: questions(), model: MODEL }),
          error => {
            caught = error
            return error instanceof sdk.AuthenticationError
          }
        )

        const { apmSpans, llmobsSpans } = await getEvents()
        // assertLlmObsSpanEvent copies the error fields from the APM span, so pin those directly
        assert.equal(apmSpans[0].meta['error.type'], 'AuthenticationError')
        assert.equal(apmSpans[0].meta['error.message'], caught.message)
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'typesafe.request',
          modelName: MODEL,
          modelProvider: 'typesafe',
          inputMessages: [{ role: 'user', content: requestBody(ERROR_STATE) }],
          outputMessages: [{ content: '', role: '' }],
          error: {
            type: 'AuthenticationError',
            message: MOCK_STRING,
            stack: MOCK_STRING,
          },
          tags: { ml_app: 'test', integration: 'typesafe', decision_provider: 'typesafe' },
        })
      })

      it('records validation errors raised before any request is sent', async () => {
        await assert.rejects(
          async () => createClient().systemOne({ state: STATE, questions: {}, model: MODEL }),
          error => error instanceof sdk.TypeSafeError
        )

        const { apmSpans, llmobsSpans } = await getEvents()
        assert.equal(apmSpans.length, 1)
        assert.equal(apmSpans[0].meta['error.type'], 'TypeSafeError')
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'typesafe.request',
          modelName: MODEL,
          modelProvider: 'typesafe',
          inputMessages: [{ role: 'user', content: requestBody(STATE, {}) }],
          outputMessages: [{ content: '', role: '' }],
          error: { type: 'TypeSafeError', message: MOCK_STRING, stack: MOCK_STRING },
          tags: { ml_app: 'test', integration: 'typesafe', decision_provider: 'typesafe' },
        })
      })

      it('records the request as it was when sent, even if the caller reuses the object', async () => {
        const request = { state: STATE, questions: questions(), model: MODEL }
        const promise = createStubbedClient().systemOne(request)
        request.state = 'A different message'
        await promise

        const { llmobsSpans } = await getEvents()
        assert.deepEqual(llmobsSpans[0].meta.input.messages, [{ role: 'user', content: requestBody(STATE) }])
      })

      it('sends what toJSON returned on its first call', async () => {
        let calls = 0
        let sent
        const client = new sdk.TypeSafeClient({
          apiKey: 'not-a-real-key',
          retry: { maxRetries: 0 },
          fetch: (url, init) => {
            sent = JSON.parse(init.body)
            return Promise.resolve(new Response(JSON.stringify(STUB_RESPONSE), {
              headers: { 'content-type': 'application/json' },
            }))
          },
        })

        const state = { toJSON: () => ({ counter: ++calls }) }
        await client.systemOne({ state, questions: questions(), model: MODEL })

        assert.deepEqual(sent.state, { counter: 1 })
        const { llmobsSpans } = await getEvents()
        const recorded = JSON.parse(llmobsSpans[0].meta.input.messages[0].content)
        // The span serializes the request again when it finishes, after the SDK has sent it
        assert.deepEqual(recorded.state, { counter: 2 })
      })

      it('records non-finite numbers as JSON writes them', async () => {
        await createStubbedClient().systemOne({ state: { score: Number.NaN }, questions: questions(), model: MODEL })

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans[0].meta.input.messages[0].content, requestBody({ score: null }))
      })

      it('omits total tokens when a usage count is missing', async () => {
        const body = JSON.stringify({ ...STUB_RESPONSE, usage: { input_tokens: 10, output_tokens: null } })
        await createStubbedClient({}, body).systemOne({ state: STATE, questions: questions(), model: MODEL })

        const { llmobsSpans } = await getEvents()
        assert.deepEqual(llmobsSpans[0].metrics, { input_tokens: 10 })
      })

      it('records a successful response that is not JSON as received', async () => {
        await createStubbedClient({}, 'upstream proxy page')
          .systemOne({ state: STATE, questions: questions(), model: MODEL })

        const { llmobsSpans } = await getEvents()
        assert.deepEqual(llmobsSpans[0].meta.output.messages, [{ role: 'assistant', content: 'upstream proxy page' }])
        assert.deepEqual(llmobsSpans[0].metrics, {})
      })
    })

    describe('image assets', () => {
      before(function () {
        if (!sdk.withAssets) this.skip() // image assets were added in 0.7.0
      })

      it('records an image in a question by its reference, not its bytes', async () => {
        const photo = sdk.image(new Uint8Array(200_000).fill(255))
        await createStubbedClient().systemOne({
          state: 'A seller uploaded a listing photo.',
          questions: { damaged: sdk.noul(sdk.withAssets`Is ${photo} damaged?`) },
          model: MODEL,
        })

        const { llmobsSpans } = await getEvents()
        const body = JSON.parse(llmobsSpans[0].meta.input.messages[0].content)
        assert.match(body.questions.damaged.instructions, new RegExp(`^Is ${IMAGE_REFERENCE} damaged\\?$`))
        assert.ok(JSON.stringify(llmobsSpans[0]).length < 10_000, 'image bytes must not reach the span')
      })

      it('records named assets by their references', async () => {
        const photo = sdk.image(new Uint8Array(1_000).fill(255))
        await createStubbedClient().systemOne({
          state: 'Compare photo with the listing.',
          questions: { damaged: sdk.noul(sdk.withAssets`Is ${photo} damaged?`) },
          assets: { photo },
          model: MODEL,
        })

        const { llmobsSpans } = await getEvents()
        const body = JSON.parse(llmobsSpans[0].meta.input.messages[0].content)
        assert.match(body.assets.photo, new RegExp(`^${IMAGE_REFERENCE}$`))
        assert.equal(body.questions.damaged.instructions, `Is ${body.assets.photo} damaged?`)
      })

      it('records text with assets as the text that was sent', async () => {
        const photo = sdk.image(new Uint8Array(1_000).fill(255))
        await createStubbedClient().systemOne({
          state: sdk.withAssets`Compare ${photo} with the listing.`,
          questions: { damaged: sdk.noul('Is the item damaged?') },
          model: MODEL,
        })

        const { llmobsSpans } = await getEvents()
        const body = JSON.parse(llmobsSpans[0].meta.input.messages[0].content)
        assert.match(body.state, new RegExp(`^Compare ${IMAGE_REFERENCE} with the listing\\.$`))
      })
    })
  })
})
