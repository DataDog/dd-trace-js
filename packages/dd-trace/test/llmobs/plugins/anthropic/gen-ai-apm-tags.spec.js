'use strict'

const assert = require('node:assert')
const { describe, before, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const { useLlmObs } = require('../../util')

describe('Plugin', () => {
  describe('gen_ai APM attributes with LLM Observability disabled', () => {
    useEnv({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
    })

    const { getEvents } = useLlmObs({
      plugin: 'anthropic',
      tracerConfigOptions: { llmobs: false },
    })

    withVersions('anthropic', '@anthropic-ai/sdk', version => {
      let client

      before(() => {
        const { Anthropic } = require(`../../../../../../versions/@anthropic-ai/sdk@${version}`).get()
        client = new Anthropic({ baseURL: 'http://127.0.0.1:9126/vcr/anthropic' })
      })

      it('tags the APM span with the operation, model, provider, application and token usage', async () => {
        await client.messages.create({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        const { apmSpans } = await getEvents(0)
        const { meta, metrics } = apmSpans[0]

        assert.deepStrictEqual(
          {
            'gen_ai.operation.name': meta['gen_ai.operation.name'],
            'gen_ai.request.model': meta['gen_ai.request.model'],
            'gen_ai.provider.name': meta['gen_ai.provider.name'],
            'gen_ai.application.name': meta['gen_ai.application.name'],
          },
          {
            'gen_ai.operation.name': 'llm',
            'gen_ai.request.model': 'claude-3-7-sonnet-20250219',
            'gen_ai.provider.name': 'anthropic',
            'gen_ai.application.name': 'test',
          }
        )

        assert.equal(typeof metrics['gen_ai.usage.input_tokens'], 'number')
        assert.equal(typeof metrics['gen_ai.usage.output_tokens'], 'number')
        assert.equal(typeof metrics['gen_ai.usage.total_tokens'], 'number')

        // message bodies stay off the APM span, and no LLMObs event is produced
        assert.equal(meta['_ml_obs.meta.input.messages'], undefined)
        assert.equal(meta['_dd.llmobs.submitted'], undefined)
      })

      it('tags a streamed request without consuming the stream for LLMObs', async () => {
        const stream = await client.messages.create({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
          stream: true,
        })

        for await (const chunk of stream) {
          assert.ok(chunk)
        }

        const { apmSpans } = await getEvents(0)
        const { meta } = apmSpans[0]

        assert.equal(meta['gen_ai.operation.name'], 'llm')
        assert.equal(meta['gen_ai.request.model'], 'claude-3-7-sonnet-20250219')
        assert.equal(meta['gen_ai.provider.name'], 'anthropic')
      })
    })
  })

  describe('gen_ai APM attributes with the integration opted out', () => {
    useEnv({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
    })

    const { getEvents } = useLlmObs({
      plugin: 'anthropic',
      pluginConfig: { llmobs: false },
      tracerConfigOptions: { llmobs: false },
    })

    withVersions('anthropic', '@anthropic-ai/sdk', version => {
      let client

      before(() => {
        const { Anthropic } = require(`../../../../../../versions/@anthropic-ai/sdk@${version}`).get()
        client = new Anthropic({ baseURL: 'http://127.0.0.1:9126/vcr/anthropic' })
      })

      it('emits nothing', async () => {
        await client.messages.create({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        const { apmSpans } = await getEvents(0)

        assert.equal(apmSpans[0].meta['gen_ai.operation.name'], undefined)
      })
    })
  })
})
