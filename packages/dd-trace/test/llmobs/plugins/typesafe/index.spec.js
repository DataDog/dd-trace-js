'use strict'

const assert = require('node:assert/strict')

const { describe, before, it } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { useLlmObs, MOCK_STRING, assertLlmObsSpanEvent } = require('../../util')

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
const STRING_STATE_OUTPUT =
  '{"team":{"type":"choice","choice":"billing","confidence":1,"probabilities":{"billing":1,"techni' +
  'cal":0,"sales":0}},"refund":{"type":"noul","noul":0.99},"urgency":{"type":"score","score":1.08,' +
  '"confidence":0.76,"legend":{"0":"Low","1":"Medium","2":"High"},"probabilities":{"0":0.04,"1":0.' +
  '84,"2":0.12}}}'
const JSON_STATE_OUTPUT =
  '{"team":{"type":"choice","choice":"billing","confidence":1,"probabilities":{"billing":1,"techni' +
  'cal":0,"sales":0}},"refund":{"type":"noul","noul":0.99},"urgency":{"type":"score","score":1.11,' +
  '"confidence":0.78,"legend":{"0":"Low","1":"Medium","2":"High"},"probabilities":{"0":0.02,"1":0.' +
  '85,"2":0.13}}}'
const STRING_STATE_METRICS = { input_tokens: 403, output_tokens: 69, total_tokens: 472 }
const JSON_STATE_METRICS = { input_tokens: 417, output_tokens: 69, total_tokens: 486 }

describe('Plugin', () => {
  const { getEvents } = useLlmObs({ plugin: 'typesafe' })

  withVersions('typesafe', '@typesafe-ai/sdk', (version) => {
    let sdk

    before(() => {
      sdk = require(`../../../../../../versions/@typesafe-ai/sdk@${version}`).get()
    })

    function createClient (apiKey = process.env.TYPESAFE_API_KEY ?? 'not-a-real-key') {
      return new sdk.TypeSafeClient({
        apiKey,
        baseURL: 'http://127.0.0.1:9126/vcr/typesafe',
        compression: false,
        retry: { maxRetries: 0 },
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
        metadata: { questions: EXPECTED_QUESTIONS },
        metrics,
        tags: { ml_app: 'test', integration: 'typesafe' },
      })
    }

    describe('systemOne', () => {
      it('creates a span', async () => {
        await createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: STATE,
          output: STRING_STATE_OUTPUT,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('serializes JSON state', async () => {
        const state = { message: STATE, plan: 'pro' }
        await createClient().systemOne({ state, questions: questions(), model: MODEL })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: JSON.stringify(state),
          output: JSON_STATE_OUTPUT,
          metrics: JSON_STATE_METRICS,
        })
      })

      it('captures the answers when the caller reads the raw response', async () => {
        const response = await createClient().systemOne({ state: STATE, questions: questions(), model: MODEL })
          .asResponse()
        assert.equal((await response.json()).model, MODEL)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertSystemOneSpan(apmSpans[0], llmobsSpans[0], {
          content: STATE,
          output: STRING_STATE_OUTPUT,
          metrics: STRING_STATE_METRICS,
        })
      })

      it('records errors', async () => {
        await assert.rejects(
          createClient('not-a-real-key').systemOne({ state: ERROR_STATE, questions: questions(), model: MODEL }),
          error => error instanceof sdk.AuthenticationError
        )

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'typesafe.request',
          modelName: MODEL,
          modelProvider: 'typesafe',
          inputMessages: [{ role: 'user', content: ERROR_STATE }],
          outputMessages: [{ content: '', role: '' }],
          metadata: { questions: EXPECTED_QUESTIONS },
          error: {
            type: 'AuthenticationError',
            message: MOCK_STRING,
            stack: MOCK_STRING,
          },
          tags: { ml_app: 'test', integration: 'typesafe' },
        })
      })
    })
  })
})
