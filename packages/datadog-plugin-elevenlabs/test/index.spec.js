'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { join } = require('node:path')

const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const { FakeAgent, spawnPluginIntegrationTestProcAndExpectExit } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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
        await conversation.startSession()
        const [socket] = await connection
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
