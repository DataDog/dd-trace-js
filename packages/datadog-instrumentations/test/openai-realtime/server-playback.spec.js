'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const RealtimeSession = require('../../src/openai-realtime/session')
const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')

function harness ({ retain = true } = {}) {
  const clock = sinon.useFakeTimers({ now: 1_000_000 })
  const emitted = []
  const requests = []
  const session = new RealtimeSession({
    emitTurn: turn => emitted.push(turn),
    captureContext: () => {},
    serverPlayback: true,
    shouldRetainAudio: () => retain,
    requestItem: (itemId, eventId) => requests.push({ itemId, eventId }),
  })
  const send = event => session.onServerEvent(event, clock.now)
  const item = (id, status = 'completed') => ({
    id,
    type: 'message',
    role: 'assistant',
    status,
    content: [{ type: 'output_audio', transcript: 'synthetic output' }],
  })
  const start = (id = 'r1', ids = ['a1'], playback = true) => {
    send({ type: 'response.created', response: { id, conversation_id: 'conversation' } })
    for (const itemId of ids) {
      send({ type: 'response.output_item.added', response_id: id, item: item(itemId, 'in_progress') })
    }
    if (playback) send({ type: 'output_audio_buffer.started', response_id: id })
    send({
      type: 'response.output_audio_transcript.done',
      response_id: id,
      item_id: ids[0],
      transcript: 'synthetic output',
    })
    send({ type: 'response.done', response: { id, status: 'completed', output: ids.map(id => item(id)) } })
    clock.tick(0)
  }
  const retrieve = (id, bytes = 48000, sample = 1) => send({
    type: 'conversation.item.retrieved',
    item: {
      ...item(id),
      content: [{ type: 'output_audio', format: 'pcm16', audio: Buffer.alloc(bytes, sample).toString('base64') }],
    },
  })
  return { clock, session, send, start, retrieve, requests, emitted }
}

describe('OpenAI server-owned playback lifecycle edges', () => {
  afterEach(() => sinon.restore())

  it('bounds missing retrieval replies after playback completion', () => {
    const h = harness()
    h.start()
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    h.clock.tick(4999)
    assert.strictEqual(h.emitted.length, 0)
    h.clock.tick(1)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].output.transcript, 'synthetic output')
    h.session.finishSession(h.clock.now)
    assert.strictEqual(h.emitted.length, 1, 'close must not duplicate a timed-out turn')
  })

  it('does not prolong the playback deadline on every received item', () => {
    const h = harness()
    h.start()
    h.clock.tick(60000)
    h.retrieve('a1')
    h.clock.tick(59999)
    assert.strictEqual(h.emitted.length, 0)
    h.clock.tick(1)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].agentSpeech, undefined)
    assert.strictEqual(h.emitted[0].output.audio.length, 0, 'playback was never observed complete')
  })

  it('falls back without audio when a retrieval command is rejected', () => {
    const h = harness()
    h.start()
    h.send({ type: 'error', error: { event_id: h.requests[0].eventId, code: 'item_unavailable' } })
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].failed, false, 'an attachment failure is not a model failure')
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
  })

  it('keeps multiple retrieved items in output order and replaces duplicates', () => {
    const h = harness()
    h.start('r1', ['a1', 'a2'])
    h.retrieve('a2', 6, 2)
    h.retrieve('a1', 4, 1)
    h.retrieve('a2', 6, 2)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.deepStrictEqual(h.emitted[0].output.audio, Buffer.from([1, 1, 1, 1, 2, 2, 2, 2, 2, 2]))
  })

  it('omits an oversized assembled clip rather than attaching a partial recording', () => {
    const h = harness()
    h.start('r1', ['a1', 'a2'])
    h.retrieve('a1', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES, 1)
    h.retrieve('a2', 2, 2)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].output.transcript, 'synthetic output')
    assert.ok(h.emitted[0].agentSpeech)
  })

  it('waits for truncation after a clear, and caps even a stale full retrieval', () => {
    const h = harness()
    h.start()
    h.retrieve('a1')
    h.clock.tick(500)
    h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 0, 'clear precedes the authoritative item boundary')
    h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 500 })
    h.retrieve('a1', 48000)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 24000)
  })

  it('omits speech boundaries when one playback window ends under a different response ID', () => {
    const h = harness({ retain: false })
    h.start('r1', ['a1'])
    h.start('r2', ['a2'], false)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    assert.strictEqual(h.emitted.length, 2)
    assert.ok(h.emitted.every(turn => turn.agentSpeech === undefined))
    assert.ok(h.emitted.every(turn => turn.output.transcript === 'synthetic output'))
  })

  it('drops generated-but-unplayed audio on disconnect', () => {
    const h = harness()
    h.start()
    h.retrieve('a1')
    h.session.finishSession(h.clock.now)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].agentSpeech, undefined)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
  })

  for (const retain of [true, false]) {
    it('places a padded caller clip across the interrupted agent window (retain=' + retain + ')', () => {
      const h = harness({ retain })
      h.send({
        type: 'session.updated',
        session: { audio: { input: { turn_detection: { type: 'server_vad', silence_duration_ms: 200 } } } },
      })
      h.start()
      if (retain) h.retrieve('a1', 81600)
      h.clock.tick(1400)
      h.send({ type: 'input_audio_buffer.speech_started', audio_start_ms: 9236 })
      h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
      h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 1400 })
      if (retain) h.retrieve('a1', 67200)

      // Captured barge-in: 1932ms between VAD observations, but 2252ms of padded audio.
      h.clock.tick(1932)
      h.send({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 11488 })
      h.send({ type: 'input_audio_buffer.committed', item_id: 'u2' })
      h.send({ type: 'response.created', response: { id: 'r2' } })
      h.send({ type: 'response.done', response: { id: 'r2', status: 'completed', output: [] } })

      assert.strictEqual(h.emitted.length, 2)
      const agent = h.emitted[0].agentSpeech
      const caller = h.emitted[1].userSpeech
      assert.strictEqual(caller.startTime, 1_001_080)
      assert.strictEqual(caller.finishTime, 1_003_132, 'remove the silence tail only from speech end')
      assert.strictEqual(agent.finishTime - caller.startTime, 320, 'retain cross-role audio overlap')
      assert.strictEqual(h.emitted[1].root.startTime, caller.startTime)
      assert.strictEqual(h.emitted[1].llm.startTime, caller.finishTime)
      if (retain) assert.strictEqual(h.emitted[0].output.audio.length, 67200)
    })
  }

  for (const [startMs, endMs] of [
    [undefined, 11488],
    [9236, undefined],
    [9236, 9235],
    [-1, 11488],
    [9236, NaN],
  ]) {
    it('keeps the observation fallback for invalid VAD offsets ' + startMs + '/' + endMs, () => {
      const h = harness({ retain: false })
      h.send({ type: 'input_audio_buffer.speech_started', audio_start_ms: startMs })
      h.clock.tick(1000)
      h.send({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: endMs })
      h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
      h.send({ type: 'response.created', response: { id: 'r1' } })
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].userSpeech.startTime, 1_000_000)
      assert.strictEqual(h.emitted[0].userSpeech.finishTime, 1_001_000)
    })
  }

  it('discards the prior VAD offset when the input buffer is cleared', () => {
    const h = harness({ retain: false })
    h.send({ type: 'input_audio_buffer.speech_started', audio_start_ms: 100 })
    h.session.onClientEvent({ type: 'input_audio_buffer.clear' }, h.clock.now)
    h.clock.tick(1000)
    h.send({ type: 'input_audio_buffer.speech_started' })
    h.clock.tick(1000)
    h.send({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 5000 })
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    assert.strictEqual(h.emitted[0].userSpeech.startTime, 1_001_000)
  })
})
