'use strict'

const assert = require('node:assert/strict')

const { describe, before, it } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { useLlmObs } = require('../../util')
const { supportsRunningNode } = require('../../../../../datadog-plugin-typesafe/test/supports-running-node')

const MODEL = 'jev-1.13.0'
const STATE = 'I was charged twice for my subscription this month and want the duplicate refunded.'

describe('Plugin', () => {
  function createClient (sdk) {
    return new sdk.TypeSafeClient({
      apiKey: process.env.TYPESAFE_API_KEY ?? 'not-a-real-key',
      baseURL: 'http://127.0.0.1:9126/vcr/typesafe',
      // 0.7.0 zstd-compresses request bodies of 1 KiB or more on Node.js 22.15+, which would make cassette bodies
      // unreadable and differ across Node.js versions
      compression: false,
      retry: { maxRetries: 0 },
    })
  }

  function questions (sdk) {
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

  describe('gen_ai APM attributes with LLM Observability disabled', () => {
    const { getEvents } = useLlmObs({
      plugin: 'typesafe',
      tracerConfigOptions: { llmobs: false },
    })

    withVersions('typesafe', '@typesafe-ai/sdk', version => {
      if (!supportsRunningNode(require(`../../../../../../versions/@typesafe-ai/sdk@${version}`))) return

      let sdk

      before(() => {
        sdk = require(`../../../../../../versions/@typesafe-ai/sdk@${version}`).get()
      })

      it('tags the APM span with the operation, model, provider and token usage', async () => {
        await createClient(sdk).systemOne({ state: STATE, questions: questions(sdk), model: MODEL })

        const { apmSpans } = await getEvents(0)
        const { meta, metrics } = apmSpans[0]

        assert.deepStrictEqual(
          {
            'gen_ai.operation.name': meta['gen_ai.operation.name'],
            'gen_ai.request.model': meta['gen_ai.request.model'],
            'gen_ai.provider.name': meta['gen_ai.provider.name'],
          },
          {
            'gen_ai.operation.name': 'llm',
            'gen_ai.request.model': MODEL,
            'gen_ai.provider.name': 'typesafe',
          }
        )
        assert.deepStrictEqual(
          {
            'gen_ai.usage.input_tokens': metrics['gen_ai.usage.input_tokens'],
            'gen_ai.usage.output_tokens': metrics['gen_ai.usage.output_tokens'],
            'gen_ai.usage.total_tokens': metrics['gen_ai.usage.total_tokens'],
          },
          {
            'gen_ai.usage.input_tokens': 403,
            'gen_ai.usage.output_tokens': 69,
            'gen_ai.usage.total_tokens': 472,
          }
        )

        // ml_app is an LLM Observability concept, so the reduced path leaves it off
        assert.equal(meta['gen_ai.application.name'], undefined)

        // the state and answers stay off the APM span, and no LLMObs event is produced
        assert.equal(meta['_ml_obs.meta.input.messages'], undefined)
        assert.equal(meta['_dd.llmobs.submitted'], undefined)
      })
    })
  })

  describe('gen_ai APM attributes with the integration opted out', () => {
    const { getEvents } = useLlmObs({
      plugin: 'typesafe',
      pluginConfig: { llmobs: false },
      tracerConfigOptions: { llmobs: false },
    })

    withVersions('typesafe', '@typesafe-ai/sdk', version => {
      if (!supportsRunningNode(require(`../../../../../../versions/@typesafe-ai/sdk@${version}`))) return

      let sdk

      before(() => {
        sdk = require(`../../../../../../versions/@typesafe-ai/sdk@${version}`).get()
      })

      it('emits nothing', async () => {
        await createClient(sdk).systemOne({ state: STATE, questions: questions(sdk), model: MODEL })

        const { apmSpans } = await getEvents(0)

        assert.equal(apmSpans[0].meta['gen_ai.operation.name'], undefined)
      })
    })
  })
})
