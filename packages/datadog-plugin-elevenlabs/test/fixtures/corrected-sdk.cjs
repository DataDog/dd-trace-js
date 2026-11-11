'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const { dirname, join } = require('node:path')

const sinon = require('sinon')

// Simulate the proposed upstream one-character correction only in this child process. Nothing
// modifies the installed SDK, and the production tracer never changes the provider's filter.
const target = join(dirname(process.env.SDK_CONVERSATION_PATH), 'Conversation.js')
const originalCompile = Module.prototype._compile
let corrected = false
Module.prototype._compile = function (source, filename) {
  if (filename === target) {
    const before = 'parseInt(audioEvent.event_id) <= this.lastInterruptId'
    assert.equal(source.split(before).length, 2, 'expected the published SDK interruption check exactly once')
    source = source.replace(before, 'parseInt(audioEvent.event_id) < this.lastInterruptId')
    corrected = true
  }
  return originalCompile.call(this, source, filename)
}
let Conversation
try {
  Conversation = require(process.env.SDK_CONVERSATION_PATH).Conversation
} finally {
  Module.prototype._compile = originalCompile
}
assert.equal(corrected, true)

const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
const socket = new EventEmitter()
socket.readyState = 1
socket.send = () => {}
socket.close = () => socket.emit('close', 1000, Buffer.alloc(0))
const accepted = []
let input
const conversation = new Conversation({
  agentId: 'synthetic',
  requiresAuth: false,
  audioInterface: {
    start (callback) { input = callback },
    stop () {},
    output (audio) { accepted.push(audio) },
    interrupt () {},
  },
  webSocketFactory: { create: () => socket },
})

/** @param {object} event */
function deliver (event) { socket.emit('message', Buffer.from(JSON.stringify(event))) }

/**
 * @param {number} id
 * @param {number} durationMs
 * @param {number} value
 */
function audio (id, durationMs, value) {
  deliver({
    type: 'audio',
    audio_event: {
      event_id: id, audio_base_64: Buffer.alloc(durationMs * 48, value).toString('base64'),
    },
  })
}

/**
 * @param {number} id
 * @param {string} text
 */
function response (id, text) {
  deliver({ type: 'agent_response', agent_response_event: { event_id: id, agent_response: text } })
}

async function main () {
  const start = conversation.startSession()
  socket.emit('open')
  await start
  deliver({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: {
      conversation_id: 'conv-corrected-sdk',
      user_input_audio_format: 'pcm_16000',
      agent_output_audio_format: 'pcm_24000',
    },
  })
  clock.tick(100)
  input(Buffer.alloc(3200, 1))
  conversation.sendUserMessage('First question')
  response(1, 'First answer')
  audio(1, 1000, 9)
  clock.tick(100)
  input(Buffer.alloc(3200, 2))
  conversation.sendUserMessage('Second question')
  deliver({ type: 'interruption', interruption_event: { event_id: 10 } })
  if (process.env.AUDIO_FIRST === 'true') audio(10, 200, 6)
  response(10, 'Replacement answer')
  if (process.env.AUDIO_FIRST !== 'true') audio(10, 200, 6)
  audio(1, 20, 4) // stale interrupted audio must stay rejected
  clock.tick(300)
  input(Buffer.alloc(3200, 3))
  conversation.sendUserMessage('Third question')
  response(20, 'Third answer')
  audio(20, 50, 5)
  clock.tick(1000)
  conversation.endSession()
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))

  assert.equal(accepted.length, 3)
}

main().finally(() => {
  clock.restore()
}).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
