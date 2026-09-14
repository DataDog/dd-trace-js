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
 * A session plus the descriptors it has emitted, with a clock the caller advances.
 *
 * @param {object} [options]
 * @param {boolean} [options.transcription]
 * @returns {{
 *   session: RealtimeSession,
 *   emitted: import('../../src/openai-realtime/session').TurnDescriptor[],
 *   now: () => number,
 *   tick: (ms: number) => void,
 * }}
 */
function openSession ({ transcription = false } = {}) {
  const emitted = []
  const session = new RealtimeSession({
    emitTurn: descriptor => emitted.push(descriptor),
    captureContext: () => {},
    model: 'gpt-realtime',
  })

  let clock = 1_000_000
  const now = () => clock

  session.onServerEvent({
    type: 'session.created',
    session: {
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          ...(transcription ? { transcription: { model: 'whisper-1' } } : {}),
        },
      },
    },
  }, clock)

  return { session, emitted, now, tick: ms => { clock += ms } }
}

/**
 * Buffer `durationMs` of microphone audio in 10 ms frames, then commit it as `itemId`.
 *
 * @param {ReturnType<typeof openSession>} harness
 * @param {string} itemId
 * @param {number} [durationMs]
 * @returns {void}
 */
function speak (harness, itemId, durationMs = 200) {
  const { session, tick, now } = harness
  for (let elapsed = 0; elapsed < durationMs; elapsed += 10) {
    tick(10)
    session.onClientEvent({ type: 'input_audio_buffer.append', audio: pcm16(10) }, now())
  }
  session.onServerEvent({ type: 'input_audio_buffer.committed', item_id: itemId }, now())
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

  // An out-of-band response runs alongside the conversation rather than as part of it, so it must
  // neither consume the buffered turn nor disturb turns already in flight.
  describe('out-of-band responses', () => {
    it('does not flush a turn still waiting for its input transcript', () => {
      const harness = openSession({ transcription: true })
      const { session, emitted, now } = harness

      // A conversational turn completes, but its transcript has not arrived — it parks in #awaiting.
      speak(harness, 'item_1')
      session.onServerEvent({ type: 'response.created', response: { id: 'resp_1' } }, now())
      session.onServerEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }, now())
      assert.strictEqual(emitted.length, 0, 'the turn should be awaiting its transcript')

      // A parallel out-of-band response must not force that turn out without its transcript.
      session.onClientEvent({ type: 'response.create', response: { conversation: 'none' } }, now())
      session.onServerEvent({ type: 'response.created', response: { id: 'resp_oob' } }, now())
      session.onServerEvent({ type: 'response.done', response: { id: 'resp_oob', status: 'completed' } }, now())

      const conversational = emitted.find(turn => turn.input.itemId !== undefined || turn.userSpeech !== undefined)
      assert.strictEqual(conversational, undefined, 'the conversational turn should still be awaiting')

      // The transcript arrives and amends the turn, which is the whole point of deferring it.
      session.onServerEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'What is the weather?',
      }, now())

      const amended = emitted.find(turn => turn.userSpeech !== undefined)
      assert.ok(amended, 'the conversational turn should be emitted once its transcript lands')
      assert.strictEqual(amended.input.transcript, 'What is the weather?')
    })

    // A rejected create never produces a `response.created`, so its queue entry would be consumed by
    // the next response — handing a genuine turn a fresh InputTurn and dropping its user speech.
    it('does not let a rejected create misclassify the next turn', () => {
      const harness = openSession()
      const { session, emitted, now } = harness

      session.onClientEvent({ type: 'response.create', response: { conversation: 'none' } }, now())
      session.onServerEvent({
        type: 'error',
        error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response' },
      }, now())

      // The next response is a genuine server-VAD turn and owns the buffered audio.
      speak(harness, 'item_1')
      session.onServerEvent({ type: 'response.created', response: { id: 'resp_1' } }, now())
      session.onServerEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }, now())

      assert.strictEqual(emitted.length, 1)
      assert.ok(emitted[0].userSpeech, 'the real turn keeps its user-speech span')
      assert.strictEqual(emitted[0].input.audio.length, 200 * PCM16_BYTES_PER_MS)
    })

    it('leaves the queue alone when the error names a different client event', () => {
      const harness = openSession()
      const { session, emitted, now } = harness

      session.onClientEvent({
        type: 'response.create',
        event_id: 'evt_create',
        response: { conversation: 'none' },
      }, now())
      // An unrelated failure — a bad audio append, say — must not retire the pending create.
      session.onServerEvent({ type: 'error', error: { type: 'invalid_request_error', event_id: 'evt_append' } }, now())

      speak(harness, 'item_1')
      session.onServerEvent({ type: 'response.created', response: { id: 'resp_oob' } }, now())
      session.onServerEvent({ type: 'response.done', response: { id: 'resp_oob', status: 'completed' } }, now())

      assert.strictEqual(emitted.length, 1)
      assert.strictEqual(emitted[0].userSpeech, undefined, 'the out-of-band response owns no speech')
      assert.strictEqual(emitted[0].input.audio.length, 0)
    })
  })

  describe('input transcription configuration', () => {
    // Latching the flag on would defer every later turn in #awaiting for a transcript that a
    // disabled session will never send.
    it('stops deferring turns once an update disables transcription', () => {
      const harness = openSession({ transcription: true })
      const { session, emitted, now } = harness

      session.onServerEvent({
        type: 'session.updated',
        session: { audio: { input: { transcription: null } } },
      }, now())

      speak(harness, 'item_1')
      session.onServerEvent({ type: 'response.created', response: { id: 'resp_1' } }, now())
      session.onServerEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }, now())

      assert.strictEqual(emitted.length, 1, 'the turn should submit immediately, not await a transcript')
    })

    it('keeps transcription on across a partial update that omits the field', () => {
      const harness = openSession({ transcription: true })
      const { session, emitted, now } = harness

      // A partial update saying nothing about transcription must not disable it.
      session.onServerEvent({
        type: 'session.updated',
        session: { audio: { output: { voice: 'verse' } } },
      }, now())

      speak(harness, 'item_1')
      session.onServerEvent({ type: 'response.created', response: { id: 'resp_1' } }, now())
      session.onServerEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }, now())

      assert.strictEqual(emitted.length, 0, 'the turn should still defer for its transcript')
    })
  })
})
