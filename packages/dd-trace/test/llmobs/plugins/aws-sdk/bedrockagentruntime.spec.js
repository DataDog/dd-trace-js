'use strict'

const assert = require('node:assert/strict')

const { describe, it, before } = require('mocha')

const { assertLlmObsSpanEvent, useLlmObs } = require('../../util')
const { withAwsSdkVersions } = require('../../../../../datadog-plugin-aws-sdk/test/spec_helpers')
const { useEnv } = require('../../../../../../integration-tests/helpers')

const AGENT_ID = 'EITYAHSOCJ'
const AGENT_ALIAS_ID = 'NWGOFQESWP'
const SESSION_ID = 'test_session'
const MODEL_NAME = 'claude-3-5-sonnet-20240620-v1:0'
const MODEL_PROVIDER = 'anthropic'
const AGENT_INPUT =
  "I like beach vacations but also nature and outdoor adventures. I'd like the trip to be 7 days, " +
  'and include lounging on the beach, something like an all-inclusive resort is nice too (but I prefer ' +
  'luxury 4/5 star resorts)'
const EXPECTED_OUTPUT =
  'Based on your preferences for a beach vacation with nature and outdoor adventures, I recommend a ' +
  '7-day trip to Manuel Antonio, Costa Rica. This destination offers beautiful beaches, lush nature, ' +
  'and plenty of outdoor activities.\n\nThe best time to visit Manuel Antonio is during the dry ' +
  'season, from December to April. This period offers ideal weather for beach activities and outdoor ' +
  'adventures. The average cost for a luxury trip to Manuel Antonio is around $200-$300 per day, ' +
  'which aligns well with your preference for 4/5 star resorts.\n\nIn Manuel Antonio, ' +
  'you can enjoy:\n1. Lounging on pristine beaches like Playa Manuel Antonio and Playa Espadilla\n2. ' +
  'Exploring Manuel Antonio National Park, known for its diverse wildlife and hiking trails\n3. ' +
  'Luxury resorts offering all-inclusive packages with stunning ocean views\n4. Adventure activities ' +
  'such as zip-lining, white-water rafting, and snorkeling\n\nThis destination perfectly combines ' +
  'your desire for beach relaxation, nature experiences, and outdoor adventures, all while providing ' +
  'the luxury accommodations you prefer.'

describe('Plugin', () => {
  describe('aws-sdk (bedrockagentruntime)', function () {
    useEnv({
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '0000000000/00000000000000000000000000000',
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '00000000000000000000',
    })

    const { getEvents } = useLlmObs({ plugin: 'aws-sdk' })

    withAwsSdkVersions('>=3', (version, moduleName) => {
      if (moduleName === 'aws-sdk') return

      let AWS
      let agentClient

      before(() => {
        const requireVersion = version === '3.0.0' ? '3.461.0' : '3'
        const clientModuleName =
          moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-bedrock-agent-runtime' : moduleName
        const fixture = require(`../../../../../../versions/${clientModuleName}@${requireVersion}`)
        AWS = fixture.get('@aws-sdk/client-bedrock-agent-runtime')
        const NodeHttpHandler =
          fixture.get('@smithy/node-http-handler')
            .NodeHttpHandler

        agentClient = new AWS.BedrockAgentRuntimeClient({
          endpoint: { url: 'http://127.0.0.1:9126/vcr/bedrock-agent-runtime' },
          region: 'us-east-1',
          requestHandler: new NodeHttpHandler(),
        })
      })

      function invoke (options = {}) {
        return agentClient.send(new AWS.InvokeAgentCommand({
          agentId: AGENT_ID,
          agentAliasId: AGENT_ALIAS_ID,
          sessionId: options.sessionId ?? SESSION_ID,
          enableTrace: options.enableTrace ?? true,
          inputText: AGENT_INPUT,
          streamingConfigurations: options.streamingConfigurations,
        }))
      }

      async function drain (response) {
        for await (const event of response.completion) {
          if (event.chunk?.bytes) Buffer.from(event.chunk.bytes).toString('utf8')
        }
      }

      it('creates an agent event and translated trace hierarchy', async () => {
        await drain(await invoke())

        const { apmSpans, llmobsSpans } = await getEvents()
        const root = llmobsSpans.find(event => event.name === `Bedrock Agent ${AGENT_ID}`)
        assert.ok(root)
        const rootApmTraceId = root._dd.apm_trace_id
        assertLlmObsSpanEvent(root, {
          span: apmSpans.find(span => String(span.span_id) === root.span_id),
          spanKind: 'agent',
          name: `Bedrock Agent ${AGENT_ID}`,
          inputValue: AGENT_INPUT,
          outputValue: EXPECTED_OUTPUT,
          sessionId: SESSION_ID,
          metadata: { agent_id: AGENT_ID, agent_alias_id: AGENT_ALIAS_ID },
          tags: { ml_app: 'test', integration: 'bedrock_agents' },
        })

        if (version === '3.0.0') return

        const translated = llmobsSpans.filter(event => event !== root)
        assert.equal(translated.length, 19)
        const steps = translated
          .filter(event => event.meta['span.kind'] === 'workflow')
          .sort((left, right) => left.start_ns - right.start_ns)
        assert.deepEqual(steps.map(event => event.name), [
          'guardrailTrace Step',
          'orchestrationTrace Step',
          'orchestrationTrace Step',
          'orchestrationTrace Step',
          'orchestrationTrace Step',
          'guardrailTrace Step',
        ])
        assert.ok(steps.every(event => event.meta.metadata.bedrock_trace_id))
        const inner = translated.filter(event => event.meta['span.kind'] !== 'workflow')
        assert.equal(inner.length, 13)
        assert.deepEqual(
          steps.map(step => inner.filter(event => event.parent_id === step.span_id).length),
          [1, 3, 3, 3, 2, 1]
        )
        assert.ok(inner.every(event => steps.some(step => step.span_id === event.parent_id)))
        const modelEvents = inner.filter(event => event.meta['span.kind'] === 'llm')
        assert.equal(modelEvents.length, 4)
        assert.ok(modelEvents.every(event => {
          return event.meta.metadata.model_name === MODEL_NAME &&
            event.meta.metadata.model_provider === MODEL_PROVIDER &&
            event.metrics.input_tokens !== undefined &&
            event.metrics.output_tokens !== undefined
        }))
        assert.ok(translated.every(event => event._dd.apm_trace_id === rootApmTraceId))
      })

      it('only creates an agent event when trace is disabled', async () => {
        await drain(await invoke({ enableTrace: false }))

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.length, 1)
        assert.equal(llmobsSpans[0].name, `Bedrock Agent ${AGENT_ID}`)
      })

      it('supports final response streaming', async () => {
        await drain(await invoke({ streamingConfigurations: { streamFinalResponse: true } }))

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.filter(event => event.name === `Bedrock Agent ${AGENT_ID}`).length, 1)
      })

      it('translates failure traces into error events', async () => {
        await drain(await invoke({ sessionId: 'failure_session' }))

        const { llmobsSpans } = await getEvents()
        const root = llmobsSpans.find(event => event.name === `Bedrock Agent ${AGENT_ID}`)
        const step = llmobsSpans.find(event => event.name === 'failureTrace Step')
        const failure = llmobsSpans.find(event => event.name === 'failureEvent')
        assert.equal(root.status, 'error')
        assert.ok(root.tags.includes('error_type:BedrockFailureException'))
        assert.equal(step.meta['span.kind'], 'workflow')
        assert.equal(failure.status, 'error')
        assert.equal(failure.meta['error.type'], version === '3.0.0' ? 'INTERNAL_SERVER_ERROR' : '500')
        assert.equal(failure.meta['error.message'], 'Something broke')
      })

      it('translates intervened guardrail traces into error events', async function () {
        if (version === '3.0.0') this.skip()

        await drain(await invoke({ sessionId: 'guardrail_session' }))

        const { llmobsSpans } = await getEvents()
        const root = llmobsSpans.find(event => event.name === `Bedrock Agent ${AGENT_ID}`)
        const guardrail = llmobsSpans.find(event => event.name === 'guardrail')
        assert.equal(root.status, 'error')
        assert.ok(root.tags.includes('error_type:BedrockGuardrailTriggeredException'))
        assert.equal(guardrail.status, 'error')
        assert.equal(guardrail.tags.includes('error_type:GuardrailTriggered'), true)
        assert.deepEqual(guardrail.meta.output.value, JSON.stringify({
          action: 'INTERVENED',
          inputAssessments: [{ topicPolicy: {} }],
          outputAssessments: [],
        }))
      })

      it('finishes orphaned model spans with their default duration', async () => {
        await drain(await invoke({ sessionId: 'orphan_session' }))

        const { llmobsSpans } = await getEvents()
        const step = llmobsSpans.find(event => event.name === 'orchestrationTrace Step')
        const model = llmobsSpans.find(event => event.name === 'modelInvocation')
        const reasoning = llmobsSpans.find(event => event.name === 'reasoning')
        assert.ok(model)
        assert.equal(model.duration, 1e6)
        assert.equal(model.meta.output.messages, undefined)
        assert.equal(reasoning.meta.output.value, 'Because this is useful.')
        const childEnds = [model, reasoning].map(event => event.start_ns + event.duration)
        assert.ok(step.start_ns <= Math.min(model.start_ns, reasoning.start_ns))
        assert.ok(step.start_ns + step.duration >= Math.max(...childEnds))
      })

      it('translates action-group and knowledge-base tools', async () => {
        await drain(await invoke({ sessionId: 'tools_session' }))

        const { llmobsSpans } = await getEvents()
        const step = llmobsSpans.find(event => event.name === 'orchestrationTrace Step')
        const actionGroup = llmobsSpans.find(event => event.name === 'location_suggestion')
        const knowledgeBase = llmobsSpans.find(event => event.name === 'KB123')
        assert.deepEqual(actionGroup.meta.input, { value: '{"city":"Paris"}' })
        assert.equal(actionGroup.meta.metadata.function, 'suggest')
        assert.equal(actionGroup.meta.metadata.execution_type, 'LAMBDA')
        assert.deepEqual(actionGroup.meta.output, { value: 'ok' })
        assert.deepEqual(knowledgeBase.meta.input, { value: '{"text":"q"}' })
        assert.deepEqual(knowledgeBase.meta.output, { value: 'ref one\nref two' })
        assert.deepEqual(step.meta.input, { value: '{"city":"Paris"}' })
        assert.deepEqual(step.meta.output, { value: 'ref one\nref two' })
      })
    })
  })
})
