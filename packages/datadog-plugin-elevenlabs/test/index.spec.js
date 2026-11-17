'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { join } = require('node:path')

const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const { FakeAgent, spawnPluginIntegrationTestProcAndExpectExit } = require('../../../integration-tests/helpers')
const { getLlmObsSpansFromApmSpans } = require('../../dd-trace/test/llmobs/util')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

/**
 * @param {object} llm
 * @param {number} durationMs
 * @param {number} value
 */
function assertOutput (llm, durationMs, value) {
  const bytes = Buffer.from(llm.meta.output.messages[0].audio_parts[0].content, 'base64')
  assert.equal(bytes.readUInt32LE(24), 24_000)
  assert.deepEqual(bytes.subarray(44), Buffer.alloc(durationMs * 48, value))
  assert.equal(llm.meta.metadata.output_audio_omitted_reason, undefined)
}

withVersions('elevenlabs', '@elevenlabs/elevenlabs-js', '>=2.75.0 <3', version => {
  describe('elevenlabs APM', () => {
    let sdkModule
    before(async () => {
      await agent.load('elevenlabs')
      sdkModule = require(`../../../versions/@elevenlabs/elevenlabs-js@${version}`)
    })
    after(() => agent.close())

    it('uses the default factory without retaining audio when LLMObs is disabled', async () => {
      const { Conversation, DefaultAudioInterface } = sdkModule.get(
        '@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation')
      const WebSocket = sdkModule.get('ws')
      const server = new WebSocket.Server({ port: 0 })
      await once(server, 'listening')
      const audio = new DefaultAudioInterface()
      const conversation = new Conversation({ agentId: 'test', requiresAuth: false, audioInterface: audio })
      conversation._getWssUrl = () => `ws://127.0.0.1:${server.address().port}`
      const connection = once(server, 'connection')
      const traces = agent.assertSomeTraces(traces => {
        const spans = traces.flat().filter(span => span.name === 'elevenlabs.request')
        assert.equal(spans.length, 2)
        assert.deepEqual(spans.map(span => span.resource).sort(), ['elevenlabs audio turn', 'elevenlabs response'])
        assert.equal(dc.channel('dd-trace:elevenlabs:audio').hasSubscribers, false)
        assert.ok(spans.every(span => span.meta.component === 'elevenlabs'))
      })
      try {
        const [, [socket]] = await Promise.all([conversation.startSession(), connection])
        const received = once(conversation, 'conversation_started')
        socket.send(JSON.stringify({
          type: 'conversation_initiation_metadata',
          conversation_initiation_metadata_event: {
            conversation_id: 'conv-default',
            user_input_audio_format: 'pcm_16000',
            agent_output_audio_format: 'pcm_24000',
          },
        }))
        await received
        const message = once(socket, 'message')
        conversation.sendUserMessage('Hi')
        await message
        const answered = new Promise(resolve => { conversation.callbackAgentResponse = resolve })
        socket.send(JSON.stringify({
          type: 'agent_response',
          agent_response_event: {
            event_id: 1,
            agent_response: 'Hello',
          },
        }))
        await answered
        conversation.endSession()
        await traces
      } finally {
        conversation.endSession()
        for (const socket of server.clients) socket.terminate()
        await new Promise(resolve => server.close(resolve))
      }
    })

    for (const llmobs of [false, true]) {
      it(`drains deferred spans on natural process exit, llmobs=${llmobs}`, async () => {
        const fakeAgent = await new FakeAgent().start()
        const apmSpans = []
        const llmobsSpans = []
        fakeAgent.on('message', ({ payload }) => { if (Array.isArray(payload)) apmSpans.push(...payload.flat()) })
        fakeAgent.on('llmobs', ({ payload }) => { for (const envelope of payload) llmobsSpans.push(...envelope.spans) })
        try {
          await spawnPluginIntegrationTestProcAndExpectExit(process.cwd(),
            'packages/datadog-plugin-elevenlabs/test/fixtures/natural-exit.cjs', fakeAgent.port, {
              SDK_CONVERSATION_PATH: sdkModule.getPath(
                '@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation'),
              DD_LLMOBS_ENABLED: String(llmobs),
              DD_LLMOBS_ML_APP: 'elevenlabs-natural-exit-test',
              DD_LLMOBS_AGENTLESS_ENABLED: 'false',
              DD_TRACE_FLUSH_INTERVAL: '60000',
              _DD_LLMOBS_FLUSH_INTERVAL: '60000',
              NODE_OPTIONS: `--import=${join(process.cwd(), 'initialize.mjs')}`,
            })
          assert.equal(apmSpans.filter(span => span.name === 'elevenlabs.request').length, 2)
          llmobsSpans.push(...getLlmObsSpansFromApmSpans(apmSpans))
          assert.equal(llmobsSpans.length, llmobs ? 2 : 0)
        } finally { await fakeAgent.stop() }
      })
    }

    for (const audioFirst of [false, true]) {
      it(`preserves full playback with the assumed SDK correction (audioFirst=${audioFirst})`, async () => {
        const fakeAgent = await new FakeAgent().start()
        const apmSpans = []
        fakeAgent.on('message', ({ payload }) => { if (Array.isArray(payload)) apmSpans.push(...payload.flat()) })
        const message = fakeAgent.assertMessageReceived(({ payload }) => {
          assert.ok(Array.isArray(payload))
          assert.ok(payload.flat().some(span => span.name === 'elevenlabs.request'))
        })
        const proc = spawnPluginIntegrationTestProcAndExpectExit(process.cwd(),
          'packages/datadog-plugin-elevenlabs/test/fixtures/corrected-sdk.cjs', fakeAgent.port, {
            SDK_CONVERSATION_PATH: sdkModule.getPath(
              '@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation'),
            AUDIO_FIRST: String(audioFirst),
            DD_LLMOBS_ENABLED: 'true',
            DD_LLMOBS_ML_APP: 'elevenlabs-corrected-sdk-test',
            DD_LLMOBS_AGENTLESS_ENABLED: 'false',
            _DD_LLMOBS_FLUSH_INTERVAL: '0',
            NODE_OPTIONS: `--import=${join(process.cwd(), 'initialize.mjs')}`,
          })
        try {
          await Promise.all([proc, message])
          const events = getLlmObsSpansFromApmSpans(apmSpans)
          assert.equal(events.length, 12)
          const llms = events.filter(event => event.name === 'elevenlabs response')
          assert.deepEqual(llms.map(llm => llm.meta.input.messages[0].content),
            ['First question', 'Second question', 'Third question'])
          assertOutput(llms[0], 100, 9)
          assertOutput(llms[1], 200, 6)
          assertOutput(llms[2], 50, 5)
          const replacement = llms[1]
          const speech = events.find(event =>
            event.name === 'agent speech' && event.parent_id === replacement.parent_id)
          assert.equal(speech.duration, 200e6)
          for (const event of events) {
            assert.equal(event.session_id, 'conv-corrected-sdk')
            assert.equal(event.meta.metadata.ttfa_eligible, false)
            assert.deepEqual(event.metrics, {})
          }
        } finally { await fakeAgent.stop() }
      })
    }

    for (const format of ['cjs', 'esm']) {
      it(`loads the actual SDK through the ${format} process entrypoint`, async () => {
        const fakeAgent = await new FakeAgent().start()
        const message = fakeAgent.assertMessageReceived(({ payload }) => {
          const spans = payload.flat().filter(span => span.name === 'elevenlabs.request')
          assert.equal(spans.length, 2)
        })
        try {
          await spawnPluginIntegrationTestProcAndExpectExit(process.cwd(),
            `packages/datadog-plugin-elevenlabs/test/fixtures/app.${format === 'esm' ? 'mjs' : 'cjs'}`,
            fakeAgent.port, {
              SDK_CONVERSATION_PATH: sdkModule.getPath(
                '@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation'),
              NODE_OPTIONS: `--import=${join(process.cwd(), 'initialize.mjs')}`,
            })
          await message
        } finally { await fakeAgent.stop() }
      })
    }
  })
})
