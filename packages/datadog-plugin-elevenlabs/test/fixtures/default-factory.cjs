'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createRequire } = require('node:module')

const dc = require('dc-polyfill')

const sdkRequire = createRequire(process.env.SDK_CONVERSATION_PATH)
const { Conversation, DefaultAudioInterface } = sdkRequire(process.env.SDK_CONVERSATION_PATH)
const WebSocket = sdkRequire('ws')

async function main () {
  const audio = new DefaultAudioInterface()
  const conversation = new Conversation({ agentId: 'test', requiresAuth: false, audioInterface: audio })
  const server = new WebSocket.Server({ port: 0 })
  try {
    await once(server, 'listening')
    conversation._getWssUrl = () => `ws://127.0.0.1:${server.address().port}`
    const [, [socket]] = await Promise.all([conversation.startSession(), once(server, 'connection')])
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
    assert.equal(dc.channel('dd-trace:elevenlabs:audio').hasSubscribers, false)
  } finally {
    conversation.endSession()
    for (const socket of server.clients) socket.terminate()
    const closed = once(server, 'close')
    server.close()
    await closed
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
