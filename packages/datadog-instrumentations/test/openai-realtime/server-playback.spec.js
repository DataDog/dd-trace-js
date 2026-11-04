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
  const start = (id = 'r1', ids = ['a1'], playback = true, response = {}) => {
    send({ type: 'response.created', response: { ...response, id, conversation_id: 'conversation' } })
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
    send({ type: 'response.done', response: { ...response, id, status: 'completed', output: ids.map(id => item(id)) } })
    clock.tick(0)
  }
  const retrieve = (id, bytes = 48000, sample = 1) => send({
    type: 'conversation.item.retrieved',
    item: {
      ...item(id),
      content: [{ type: 'output_audio', format: 'pcm16', audio: Buffer.alloc(bytes, sample).toString('base64') }],
    },
  })
  return { clock, session, send, start, retrieve, requests, emitted, item }
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

  for (const outcome of ['error', 'timeout']) {
    it('omits a partial multi-item recording after retrieval ' + outcome, () => {
      const h = harness()
      h.start('r1', ['a1', 'a2'])
      h.retrieve('a1', 4)
      if (outcome === 'error') {
        h.send({ type: 'error', error: { event_id: h.requests.find(x => x.itemId === 'a2').eventId } })
      }
      h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
      if (outcome === 'timeout') h.clock.tick(5000)
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].output.audio.length, 0)
      assert.strictEqual(h.emitted[0].output.audioPresent, true)
      assert.strictEqual(h.emitted[0].output.transcript, 'synthetic output')
      assert.strictEqual(h.emitted[0].failed, false)
    })
  }

  it('requires every expected audio content part before assembling a clip', () => {
    const h = harness()
    h.start()
    h.send({
      type: 'response.output_item.done',
      response_id: 'r1',
      item: {
        id: 'a1',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_audio' }, { type: 'output_audio' }],
      },
    })
    h.retrieve('a1', 4)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].output.audioPresent, true)
  })

  it('preserves the audio marker when truncation precedes every retrieval', () => {
    const h = harness()
    h.start()
    h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
    h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 500 })
    h.clock.tick(5000)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].output.audioPresent, true)
  })

  it('preserves the input audio marker when its retrieval fails', () => {
    const h = harness()
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.send({
      type: 'conversation.item.done',
      item: { id: 'u1', type: 'message', role: 'user', content: [{ type: 'input_audio' }] },
    })
    h.clock.tick(0)
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    h.send({ type: 'error', error: { event_id: h.requests[0].eventId } })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].input.audio.length, 0)
    assert.strictEqual(h.emitted[0].input.audioPresent, true)
  })

  it('uses the short deadline for generated audio that never starts playing', () => {
    const h = harness()
    h.start('r1', ['a1'], false)
    h.retrieve('a1')
    h.clock.tick(4999)
    assert.strictEqual(h.emitted.length, 0)
    h.clock.tick(1)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].agentSpeech, undefined)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].output.audioPresent, true)
  })

  it('releases completed never-played audio when newer playback starts', () => {
    const h = harness()
    h.start('r1', ['a1'], false)
    h.retrieve('a1')
    h.clock.tick(100)
    h.start('r2', ['a2'])
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].agentSpeech, undefined)
    h.retrieve('a2')
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    assert.strictEqual(h.emitted.length, 2)
    assert.ok(h.emitted[1].agentSpeech)
  })

  it('extends the short startup wait only once playback actually starts', () => {
    const h = harness()
    h.start('r1', ['a1'], false)
    h.retrieve('a1')
    h.clock.tick(4999)
    h.send({ type: 'output_audio_buffer.started', response_id: 'r1' })
    h.clock.tick(6000)
    assert.strictEqual(h.emitted.length, 0)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 48000)
  })

  it('evicts a completed turn before an older turn still generating', () => {
    const h = harness()
    h.send({ type: 'response.created', response: { id: 'generating' } })
    for (let i = 0; i < 127; i++) h.start('held-' + i, ['audio-' + i], false)
    assert.strictEqual(h.emitted.length, 0)
    h.start('newest', ['audio-newest'], false)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.transcript, 'synthetic output')
    h.send({
      type: 'response.done',
      response: { id: 'generating', status: 'completed', output: [], usage: { input_tokens: 99, output_tokens: 1 } },
    })
    assert.strictEqual(h.emitted.length, 2)
    assert.strictEqual(h.emitted[1].usage.input_tokens, 99)
    h.session.finishSession(h.clock.now)
  })

  it('preserves generating turns when the tracking limit has no completed victim', () => {
    const h = harness({ retain: false })
    for (let i = 0; i < 129; i++) h.send({ type: 'response.created', response: { id: 'r' + i } })
    assert.strictEqual(h.emitted.length, 0)
    h.send({
      type: 'response.done',
      response: { id: 'r0', status: 'completed', output: [], usage: { input_tokens: 99, output_tokens: 1 } },
    })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].usage.input_tokens, 99)
    h.session.finishSession(h.clock.now)
  })

  it('does not finalize a generating turn under item capacity pressure', () => {
    const h = harness({ retain: false })
    h.send({ type: 'response.created', response: { id: 'generating' } })
    for (let i = 0; i < 256; i++) {
      h.send({
        type: 'response.output_item.added',
        response_id: 'generating',
        item: { id: 'a' + i, type: 'message', status: 'in_progress', content: [{ type: 'output_audio' }] },
      })
    }
    h.send({ type: 'response.created', response: { id: 'overflow' } })
    h.send({
      type: 'response.output_item.added',
      response_id: 'overflow',
      item: { id: 'extra', type: 'message', status: 'in_progress', content: [{ type: 'output_audio' }] },
    })
    assert.strictEqual(h.emitted.length, 0)
    h.send({
      type: 'response.done',
      response: { id: 'generating', status: 'completed', output: [], usage: { input_tokens: 99, output_tokens: 1 } },
    })
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'generating' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].usage.input_tokens, 99)
    assert.strictEqual(h.emitted[0].output.audioPresent, true)
    h.session.finishSession(h.clock.now)
  })

  for (const truncate of [true, false]) {
    it('holds a cross-response clear until the earlier truncation or timeout (truncate=' + truncate + ')', () => {
      const h = harness()
      h.start('r1', ['a1'])
      h.retrieve('a1')
      h.start('r2', ['a2'], false)
      h.retrieve('a2')
      h.clock.tick(500)
      h.send({ type: 'output_audio_buffer.cleared', response_id: 'r2' })
      assert.strictEqual(h.emitted.length, 0)
      if (truncate) {
        h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 500 })
        h.clock.tick(0)
        h.retrieve('a1')
        assert.strictEqual(h.emitted.length, 1)
        assert.strictEqual(h.emitted[0].output.audio.length, 24000)
      } else {
        h.clock.tick(5000)
        assert.strictEqual(h.emitted.length, 2)
        assert.ok(h.emitted.every(turn => turn.output.audio.length === 0))
      }
      h.session.finishSession(h.clock.now)
    })
  }

  for (const laterRetrieved of [true, false]) {
    it('excludes later audio items without waiting for them (retrieved=' + laterRetrieved + ')', () => {
      const h = harness()
      h.start('r1', ['a1', 'a2'])
      h.retrieve('a1')
      if (laterRetrieved) h.retrieve('a2')
      h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
      h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 500 })
      h.clock.tick(0)
      h.retrieve('a1')
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].output.audio.length, 24000)
      assert.strictEqual(h.emitted[0].output.audioPresent, true)
      h.retrieve('a2')
      assert.strictEqual(h.emitted.length, 1, 'a delayed excluded retrieval must not re-emit the turn')
    })
  }

  for (const contentIndex of [0, 1]) {
    it('keeps only content parts up to the interruption boundary ' + contentIndex, () => {
      const h = harness()
      h.start()
      const content = [0, 1].map(() => ({
        type: 'output_audio', format: 'pcm16', audio: Buffer.alloc(48000, 1).toString('base64'),
      }))
      const retrieve = () => h.send({ type: 'conversation.item.retrieved', item: { ...h.item('a1'), content } })
      h.send({ type: 'response.output_item.done', response_id: 'r1', item: { ...h.item('a1'), content } })
      retrieve()
      h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
      h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: contentIndex, audio_end_ms: 500 })
      h.clock.tick(0)
      retrieve()
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].output.audio.length, contentIndex * 48000 + 24000)
    })
  }

  it('does not request an output item bound after an earlier truncation', () => {
    const h = harness()
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'response.output_item.added', response_id: 'r1', item: h.item('a1') })
    h.send({ type: 'output_audio_buffer.started', response_id: 'r1' })
    h.clock.tick(0)
    h.retrieve('a1')
    h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
    h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 500 })
    h.send({ type: 'response.output_item.added', response_id: 'r1', item: h.item('a2') })
    h.send({
      type: 'response.done',
      response: { id: 'r1', status: 'completed', output: [h.item('a1'), h.item('a2')] },
    })
    h.clock.tick(0)
    h.retrieve('a1')
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 24000)
    assert.ok(h.requests.every(request => request.itemId !== 'a2'))
  })

  for (const role of ['user', 'assistant']) {
    for (const explicit of [true, false]) {
      it('handles a ' + role + ' format change during retrieval (explicit=' + explicit + ')', () => {
        const h = harness()
        h.send({
          type: 'session.created',
          session: {
            audio: {
              input: { format: { type: 'audio/pcm', rate: 24000 } },
              output: { format: { type: 'audio/pcm', rate: 24000 } },
            },
          },
        })
        const id = role === 'user' ? 'u1' : 'a1'
        if (role === 'user') {
          h.send({ type: 'input_audio_buffer.committed', item_id: id })
          h.send({ type: 'response.created', response: { id: 'r1' } })
        } else {
          h.start()
        }
        h.send({
          type: 'session.updated',
          session: {
            audio: {
              input: { format: { type: 'audio/pcmu' } }, output: { format: { type: 'audio/pcmu' } },
            },
          },
        })
        const part = {
          type: role === 'user' ? 'input_audio' : 'output_audio',
          audio: Buffer.alloc(48000, 1).toString('base64'),
        }
        if (explicit) part.format = 'pcm16'
        h.send({ type: 'conversation.item.retrieved', item: { id, type: 'message', role, content: [part] } })
        if (role === 'user') {
          h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
        } else {
          h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
        }
        assert.strictEqual(h.emitted.length, 1)
        const side = role === 'user' ? h.emitted[0].input : h.emitted[0].output
        assert.strictEqual(side.audio.length, explicit ? 48000 : 0)
        assert.strictEqual(side.audioPresent, true)
        if (explicit) assert.strictEqual(side.mimeType, 'audio/pcm')
      })
    }
  }

  for (const explicit of [true, false]) {
    it('requires codec evidence for a response override (explicit=' + explicit + ')', () => {
      const h = harness()
      h.send({ type: 'session.created', session: { audio: { output: { format: { type: 'audio/pcm' } } } } })
      h.start('r1', ['a1'], true, { audio: { output: { format: { type: 'audio/pcmu' } } } })
      const part = { type: 'output_audio', audio: Buffer.alloc(8000, 1).toString('base64') }
      if (explicit) part.format = 'g711_ulaw'
      const retrieve = () => h.send({
        type: 'conversation.item.retrieved', item: { ...h.item('a1'), content: [part] },
      })
      retrieve()
      h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
      h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 500 })
      h.clock.tick(0)
      retrieve()
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].output.audio.length, explicit ? 4000 : 0)
      assert.strictEqual(h.emitted[0].output.audioPresent, true)
      assert.strictEqual(h.emitted[0].output.transcript, 'synthetic output')
    })
  }

  for (const firstRetrieved of [true, false]) {
    it('retires superseded input bindings (first retrieved=' + firstRetrieved + ')', () => {
      const h = harness()
      const retrieve = (id, transcript, sample) => h.send({
        type: 'conversation.item.retrieved',
        item: {
          id,
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_audio', format: 'pcm16', audio: Buffer.alloc(4, sample).toString('base64'), transcript,
          }],
        },
      })
      h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
      h.send({
        type: 'conversation.item.done',
        item: { id: 'u1', type: 'message', role: 'user', content: [{ type: 'input_audio' }] },
      })
      if (firstRetrieved) retrieve('u1', 'older input', 1)
      h.send({ type: 'input_audio_buffer.committed', item_id: 'u2' })
      h.send({ type: 'response.created', response: { id: 'r1' } })
      retrieve('u1', 'older input', 1)
      h.send({
        type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'latest input',
      })
      retrieve('u2', 'latest input', 2)
      retrieve('u1', 'older input', 1)
      h.clock.tick(0)
      assert.ok(h.requests.every(request => request.itemId !== 'u1'), 'the superseded request must not be sent')
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].input.transcript, 'latest input')
      assert.deepStrictEqual(h.emitted[0].input.audio, Buffer.alloc(4, 2))
    })
  }
  it('retains formatless audio when the capture and current codecs agree', () => {
    const h = harness()
    h.start()
    h.send({
      type: 'conversation.item.retrieved',
      item: { ...h.item('a1'), content: [{ type: 'output_audio', audio: Buffer.alloc(48000, 1).toString('base64') }] },
    })
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 48000)
    assert.strictEqual(h.emitted[0].output.mimeType, 'audio/pcm')
  })

  it('ignores a superseded input reply after its retrieval was already sent', () => {
    const h = harness()
    const retrieve = (id, sample) => h.send({
      type: 'conversation.item.retrieved',
      item: {
        id,
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_audio', format: 'pcm16', audio: Buffer.alloc(4, sample).toString('base64'),
        }],
      },
    })
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.send({
      type: 'conversation.item.done',
      item: { id: 'u1', type: 'message', role: 'user', content: [{ type: 'input_audio' }] },
    })
    h.clock.tick(0)
    assert.strictEqual(h.requests[0].itemId, 'u1')
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u2' })
    h.send({ type: 'response.created', response: { id: 'r1' } })
    retrieve('u2', 2)
    retrieve('u1', 1)
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    assert.strictEqual(h.emitted.length, 1)
    assert.deepStrictEqual(h.emitted[0].input.audio, Buffer.alloc(4, 2))
  })
})
