'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const RealtimeSession = require('../../src/openai-realtime/session')

// PCM16 mono at 24 kHz — the Realtime default — is 48 bytes per millisecond.
const PCM16_BYTES_PER_MS = 48

/**
 * @param {number} durationMs
 * @returns {string}
 */
function pcm16 (durationMs) {
  return Buffer.alloc(durationMs * PCM16_BYTES_PER_MS).toString('base64')
}

/**
 * Drive one spoken turn through a session and return the descriptor it emits.
 *
 * @param {object} [options]
 * @param {boolean} [options.retainAudio]
 * @returns {import('../../src/openai-realtime/session').TurnDescriptor}
 */
function runTurn ({ retainAudio = true } = {}) {
  const emitted = []
  const session = new RealtimeSession({
    emitTurn: descriptor => emitted.push(descriptor),
    captureContext: () => {},
    model: 'gpt-realtime',
    retainAudio,
  })

  let now = 1_000_000
  const tick = ms => { now += ms }

  session.onServerEvent({
    type: 'session.created',
    session: { audio: { input: { format: { type: 'audio/pcm', rate: 24_000 } } } },
  }, now)

  // 100ms of lead-in, then the VAD onset, then 200ms of speech.
  for (let i = 0; i < 10; i++) {
    tick(10)
    session.onClientEvent({ type: 'input_audio_buffer.append', audio: pcm16(10) }, now)
  }
  session.onServerEvent({ type: 'input_audio_buffer.speech_started', audio_start_ms: 100 }, now)
  for (let i = 0; i < 20; i++) {
    tick(10)
    session.onClientEvent({ type: 'input_audio_buffer.append', audio: pcm16(10) }, now)
  }
  session.onServerEvent({ type: 'input_audio_buffer.committed', item_id: 'item_1' }, now)

  session.onServerEvent({ type: 'response.created', response: { id: 'resp_1' } }, now)
  tick(50)
  session.onServerEvent({
    type: 'response.output_audio.delta',
    response_id: 'resp_1',
    item_id: 'out_1',
    delta: pcm16(600),
  }, now)
  session.onServerEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }, now)

  assert.strictEqual(emitted.length, 1)
  return emitted[0]
}

describe('openai realtime RealtimeSession', () => {
  // LLM Observability is the only consumer of the audio bytes and is off by default, so the
  // instrumentation stops retaining them when nothing is subscribed. The timing must not move with
  // it: the speech windows are derived from the byte *counts*, which are still tracked.
  describe('with audio retention off', () => {
    it('reports the same speech windows as a retaining session', () => {
      const retained = runTurn({ retainAudio: true })
      const counted = runTurn({ retainAudio: false })

      for (const phase of ['root', 'llm', 'userSpeech', 'agentSpeech']) {
        assert.deepStrictEqual(
          counted[phase], retained[phase], `${phase} boundaries should not depend on retention`
        )
      }
    })

    it('carries no audio bytes, but still reports the format and that audio was present', () => {
      const counted = runTurn({ retainAudio: false })

      assert.strictEqual(counted.input.audio.length, 0)
      assert.strictEqual(counted.output.audio.length, 0)
      assert.strictEqual(counted.input.audioPresent, true)
      assert.strictEqual(counted.output.audioPresent, true)
      assert.strictEqual(counted.input.mimeType, 'audio/pcm')
      assert.strictEqual(counted.input.sampleRate, 24_000)
    })

    it('still carries the audio when retention is on', () => {
      const retained = runTurn({ retainAudio: true })

      // 200ms of speech survives the lead-in trim; the agent's 600ms arrives whole.
      assert.strictEqual(retained.input.audio.length, 200 * PCM16_BYTES_PER_MS)
      assert.strictEqual(retained.output.audio.length, 600 * PCM16_BYTES_PER_MS)
    })
  })
})
