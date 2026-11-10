'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const RealtimeSession = require('../../src/openai-realtime/session')
const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')

function harness ({ retain = true, retrieveAudio = true } = {}) {
  const clock = sinon.useFakeTimers({ now: 1_000_000 })
  const emitted = []
  const requests = []
  const session = new RealtimeSession({
    emitTurn: turn => emitted.push(turn),
    captureContext: () => {},
    serverPlayback: true,
    shouldRetainAudio: () => retain,
    requestItem: retrieveAudio ? (itemId, eventId) => requests.push({ itemId, eventId }) : undefined,
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
    send({ type: 'response.created', response: { conversation_id: 'conversation', ...response, id } })
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
  const retrieveInput = (id, bytes = 48000, transcript = '', status = 'completed') => send({
    type: 'conversation.item.retrieved',
    item: {
      id,
      type: 'message',
      role: 'user',
      status,
      content: [{ type: 'input_audio', format: 'pcm16', audio: Buffer.alloc(bytes, 1).toString('base64'), transcript }],
    },
  })
  return { clock, session, send, start, retrieve, retrieveInput, requests, emitted, item }
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

  for (const status of ['completed', 'in_progress', undefined]) {
    it('reuses only completed retrieved snapshots before response.done (status=' + status + ')', () => {
      const h = harness()
      h.send({ type: 'response.created', response: { id: 'r1', conversation_id: 'conversation' } })
      h.send({ type: 'response.output_item.added', response_id: 'r1', item: h.item('a1', 'in_progress') })
      h.send({ type: 'output_audio_buffer.started', response_id: 'r1' })
      h.session.onClientEvent({ type: 'conversation.item.retrieve', item_id: 'a1' }, h.clock.now)
      h.send({
        type: 'conversation.item.retrieved',
        item: {
          ...h.item('a1'),
          status,
          content: [{ type: 'output_audio', format: 'pcm16', audio: Buffer.alloc(48000).toString('base64') }],
        },
      })
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [h.item('a1')] } })
      h.clock.tick(0)
      assert.strictEqual(h.requests.length, status === 'completed' ? 0 : 1)
      if (status !== 'completed') h.retrieve('a1')
      h.clock.tick(1000)
      h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].output.audio.length, 48000)
    })
  }

  it('refetches a completed snapshot when a later expected audio part is missing', () => {
    const h = harness()
    h.start()
    h.retrieve('a1')
    const message = h.item('a1')
    message.content.push({ type: 'output_audio', transcript: 'second part' })
    const before = h.requests.length
    h.send({ type: 'response.output_item.done', response_id: 'r1', item: message })
    h.clock.tick(0)
    assert.strictEqual(h.requests.length, before + 1)
    h.session.finishSession(h.clock.now)
  })

  it('bounds the decoded cache before allocation and recovers after a turn releases capacity', () => {
    const h = harness()
    const decode = sinon.spy(Buffer, 'allocUnsafeSlow')
    for (let i = 0; i < 4; i++) {
      h.start('r' + i, ['a' + i], i === 0)
      h.retrieve('a' + i, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    }
    assert.strictEqual(decode.callCount, 4)
    assert.ok(decode.getCalls().every(call => call.args[0] === LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES))
    h.start('overflow', ['overflow-audio'], false)
    h.retrieve('overflow-audio', 2)
    assert.strictEqual(decode.callCount, 4, 'the first PCM sample beyond 12 MiB must not allocate')
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r0' })
    h.session.onClientEvent({ type: 'conversation.item.retrieve', item_id: 'overflow-audio' }, h.clock.now)
    h.retrieve('overflow-audio', 2)
    assert.strictEqual(decode.callCount, 5)
    h.send({ type: 'output_audio_buffer.started', response_id: 'overflow' })
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'overflow' })
    assert.strictEqual(h.emitted.at(-1).output.audio.length, 2)
    assert.strictEqual(h.emitted.at(-1).output.audioPresent, true)
  })

  it('shares the cache budget across caller and agent audio', () => {
    const h = harness()
    const decode = sinon.spy(Buffer, 'allocUnsafeSlow')
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.retrieveInput('u1', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    for (let i = 0; i < 3; i++) {
      h.start('r' + i, ['a' + i], i === 0)
      h.retrieve('a' + i, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    }
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u2' })
    h.retrieveInput('u2', 2)
    assert.strictEqual(decode.callCount, 4)
    h.session.finishSession(h.clock.now)
  })

  it('cancels a superseded input wait rather than retaining its timer', () => {
    const h = harness()
    h.send({ type: 'session.updated', session: { input_audio_transcription: { model: 'whisper-1' } } })
    const commit = id => {
      h.send({ type: 'input_audio_buffer.committed', item_id: id })
      h.send({ type: 'conversation.item.done', item: { id, role: 'user', content: [{ type: 'input_audio' }] } })
    }
    commit('u1')
    assert.strictEqual(h.clock.countTimers(), 1)
    h.clock.tick(1000)
    commit('u2')
    assert.strictEqual(h.clock.countTimers(), 1)
    h.clock.tick(1501)
    assert.strictEqual(h.requests.length, 0)
    h.clock.tick(1000)
    assert.deepStrictEqual(h.requests.map(request => request.itemId), ['u2'])
    h.session.finishSession(h.clock.now)
    assert.strictEqual(h.clock.countTimers(), 0)
  })

  it('charges the original backing allocation after truncation shortens a view', () => {
    const h = harness()
    const decode = sinon.spy(Buffer, 'allocUnsafeSlow')
    for (let i = 0; i < 4; i++) {
      h.start('r' + i, ['a' + i], i === 0)
      h.retrieve('a' + i, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    }
    h.send({ type: 'conversation.item.truncated', item_id: 'a0', content_index: 0, audio_end_ms: 1 })
    h.start('overflow', ['overflow-audio'], false)
    h.retrieve('overflow-audio', 2)
    assert.strictEqual(decode.callCount, 4, 'a 48-byte view still retains its full 3 MiB backing store')
    h.session.finishSession(h.clock.now)
  })

  it('releases replacement backing before admitting a fresh full-budget snapshot', () => {
    const h = harness()
    const decode = sinon.spy(Buffer, 'allocUnsafeSlow')
    for (let i = 0; i < 4; i++) {
      h.start('r' + i, ['a' + i], i === 0)
      h.retrieve('a' + i, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    }
    h.retrieve('a0', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES, 2)
    assert.strictEqual(decode.callCount, 5)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r0' })
    assert.strictEqual(h.emitted[0].output.audio[0], 2)
    h.session.finishSession(h.clock.now)
  })

  it('drops a whole logical clip when session pressure prevents another part', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) {
      h.start('r' + i, ['a' + i], i === 0)
      h.retrieve('a' + i, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    }
    h.start('multipart', ['m1', 'm2'], false)
    h.retrieve('m1', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES / 2)
    h.start('other', ['other-audio'], false)
    h.retrieve('other-audio', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES / 2)
    const decode = sinon.spy(Buffer, 'allocUnsafeSlow')
    h.retrieve('m2', 2)
    assert.strictEqual(decode.callCount, 0)
    h.send({ type: 'output_audio_buffer.started', response_id: 'multipart' })
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'multipart' })
    const turn = h.emitted.find(turn => turn.agentSpeech?.startTime !== undefined && turn.output.audio.length === 0)
    assert.ok(turn, 'pressure must keep a marker rather than attach the retained prefix')
    assert.strictEqual(turn.output.audioPresent, true)
    assert.strictEqual(turn.output.transcript, 'synthetic output')
    h.session.finishSession(h.clock.now)
  })

  it('releases orphan input buffers when item pressure retires an untracked turn', () => {
    const h = harness()
    for (let i = 0; i < 16; i++) {
      h.send({ type: 'response.created', response: { id: 'generating-' + i, conversation_id: null } })
    }
    h.clock.tick(70000)
    h.send({ type: 'input_audio_buffer.committed', item_id: 'orphan' })
    h.retrieveInput('orphan', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    h.send({ type: 'response.created', response: { id: 'overflow' } })
    for (let i = 0; i < 256; i++) {
      h.send({ type: 'response.output_item.added', response_id: 'generating-0', item: h.item('a-' + i, 'in_progress') })
    }
    h.send({ type: 'response.done', response: { id: 'overflow', status: 'completed', output: [] } })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].input.audio.length, 0)
    assert.strictEqual(h.emitted[0].input.audioPresent, true)
    h.session.finishSession(h.clock.now)
  })

  it('does not refetch its own completed audio while later output is still generating', () => {
    const h = harness()
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'output_audio_buffer.started', response_id: 'r1' })
    h.send({ type: 'response.output_item.done', response_id: 'r1', item: h.item('a1') })
    h.clock.tick(0)
    assert.strictEqual(h.requests.length, 1)
    h.retrieve('a1')
    h.send({
      type: 'response.done',
      response: {
        id: 'r1',
        status: 'completed',
        output: [h.item('a1'),
          { id: 'f1', type: 'function_call', call_id: 'call1', name: 'check_availability', arguments: '{}' }],
      },
    })
    h.clock.tick(0)
    assert.strictEqual(h.requests.length, 1)
    h.clock.tick(1000)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 48000)
    assert.strictEqual(h.emitted[0].output.toolCalls[0].name, 'check_availability')
  })

  it('never exposes unwritten bytes from malformed base64', () => {
    const h = harness()
    h.start()
    h.send({
      type: 'conversation.item.retrieved',
      item: { ...h.item('a1'), content: [{ type: 'output_audio', format: 'pcm16', audio: '!!!!' }] },
    })
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].output.audioPresent, true)
  })

  for (const terminal of ['completed', 'failed', 'timeout', 'close']) {
    it('prefers SDK input retrieval with a bounded ' + terminal + ' path', () => {
      const h = harness()
      h.send({ type: 'session.updated', session: { input_audio_transcription: { model: 'whisper-1' } } })
      h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
      h.send({ type: 'conversation.item.done', item: { id: 'u1', role: 'user', content: [{ type: 'input_audio' }] } })
      h.clock.tick(2499)
      assert.strictEqual(h.requests.length, 0)
      if (terminal === 'close') {
        h.session.finishSession(h.clock.now)
        h.clock.tick(10000)
        assert.strictEqual(h.requests.length, 0)
        return
      }
      if (terminal !== 'timeout') {
        h.send({ type: 'conversation.item.input_audio_transcription.' + terminal, item_id: 'u1', transcript: 'input' })
        if (terminal === 'completed') {
          h.session.onClientEvent({ type: 'conversation.item.retrieve', item_id: 'u1' }, h.clock.now)
        }
      }
      h.clock.tick(1)
      if (terminal === 'timeout') {
        assert.strictEqual(h.requests.length, 0, 'fallback dispatch runs on the next immediate')
        h.clock.tick(1)
      }
      assert.strictEqual(h.requests.length, terminal === 'completed' ? 0 : 1)
      h.retrieveInput('u1', 48000, 'input')
      h.send({ type: 'response.created', response: { id: 'r1' } })
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].input.audio.length, 48000)
      h.clock.tick(10000)
      assert.strictEqual(h.requests.length, terminal === 'completed' ? 0 : 1)
    })
  }

  for (const unavailable of ['disabled', 'failed', 'exhausted']) {
    it('releases transcription ownership when dispatch is ' + unavailable, () => {
      const h = harness({ retrieveAudio: unavailable !== 'disabled' })
      h.send({ type: 'session.updated', session: { input_audio_transcription: { model: 'whisper-1' } } })
      h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
      h.send({ type: 'conversation.item.done', item: { id: 'u1', role: 'user', content: [{ type: 'input_audio' }] } })
      if (unavailable !== 'disabled') {
        h.clock.tick(2501)
        assert.strictEqual(h.requests.length, 1)
        if (unavailable === 'failed') {
          h.send({ type: 'error', error: { event_id: h.requests[0].eventId } })
        } else {
          h.retrieveInput('u1', 4, '', 'in_progress')
          h.send({ type: 'conversation.item.done', item: { id: 'u1', content: [{ type: 'input_audio' }] } })
          h.clock.tick(0)
          assert.strictEqual(h.requests.length, 2)
          h.retrieveInput('u1', 4, '', 'in_progress')
        }
      }
      h.send({ type: 'response.created', response: { id: 'r1' } })
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
      h.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'input' })
      assert.strictEqual(h.emitted.length, 0, 'leave the synchronous SDK handler time to send')
      h.clock.tick(0)
      assert.strictEqual(h.emitted.length, 1, 'no SDK request arrived, so release on the next immediate')
      assert.strictEqual(h.emitted[0].input.transcript, 'input')
      assert.strictEqual(h.requests.length, unavailable === 'disabled' ? 0 : unavailable === 'failed' ? 1 : 2)
      h.clock.tick(10000)
      assert.strictEqual(h.emitted.length, 1)
      h.session.finishSession(h.clock.now)
    })
  }

  it('keeps deferred caller retrieval out of another item dispatch batch', () => {
    const h = harness()
    h.send({ type: 'session.updated', session: { input_audio_transcription: { model: 'whisper-1' } } })
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.send({ type: 'conversation.item.done', item: { id: 'u1', role: 'user', content: [{ type: 'input_audio' }] } })
    h.start()
    assert.deepStrictEqual(h.requests.map(request => request.itemId), ['a1'])
    h.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'input' })
    h.session.onClientEvent({ type: 'conversation.item.retrieve', item_id: 'u1' }, h.clock.now)
    h.retrieveInput('u1', 48000, 'input')
    h.retrieve('a1')
    h.clock.tick(1000)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].input.audio.length, 48000)
    assert.deepStrictEqual(h.requests.map(request => request.itemId), ['a1'])
  })

  it('keeps caller timing stable when the agent audio is truncated', () => {
    const h = harness()
    h.clock.tick(1000)
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.retrieveInput('u1')
    h.start()
    h.retrieve('a1', 96000)
    h.clock.tick(500)
    h.send({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
    h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 500 })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].userSpeech.startTime, 1000000)
    assert.strictEqual(h.emitted[0].userSpeech.finishTime, 1001000)
    assert.strictEqual(h.emitted[0].agentSpeech.finishTime, 1001500)
    assert.strictEqual(h.emitted[0].output.audio.length, 24000)
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

  for (const retain of [true, false]) {
    for (const interrupted of [true, false]) {
      it('preserves consecutive response playback (retain=' + retain + ', interrupted=' + interrupted + ')', () => {
        const h = harness({ retain })
        h.start('r1', ['a1'])
        if (retain) h.retrieve('a1', 146400)
        h.clock.tick(3050)
        h.start('r2', ['a2'])
        if (retain) h.retrieve('a2', 220800)

        assert.strictEqual(h.emitted.length, 1)
        assert.deepStrictEqual(h.emitted[0].agentSpeech, {
          startTime: 1000000, finishTime: 1003050, transcript: 'synthetic output',
        })
        assert.strictEqual(h.emitted[0].output.audio.length, retain ? 146400 : 0)

        h.clock.tick(interrupted ? 2300 : 4600)
        h.send({ type: 'output_audio_buffer.' + (interrupted ? 'cleared' : 'stopped'), response_id: 'r2' })
        if (interrupted) {
          h.send({ type: 'conversation.item.truncated', item_id: 'a2', content_index: 0, audio_end_ms: 2300 })
          h.clock.tick(0)
          if (retain) h.retrieve('a2', 220800)
        }
        assert.strictEqual(h.emitted.length, 2)
        assert.deepStrictEqual(h.emitted[1].agentSpeech, {
          startTime: 1003050, finishTime: interrupted ? 1005350 : 1007650, transcript: 'synthetic output',
        })
        assert.strictEqual(h.emitted[1].output.audio.length, retain ? (interrupted ? 110400 : 220800) : 0)
      })
    }
  }

  it('keeps consecutive response playback boundaries while the earlier retrieval is pending', () => {
    const h = harness()
    h.start('r1', ['a1'])
    h.clock.tick(3050)
    h.start('r2', ['a2'])
    h.retrieve('a2', 220800)
    assert.strictEqual(h.emitted.length, 0)
    h.retrieve('a1', 146400)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].agentSpeech.finishTime, 1003050)
    h.clock.tick(4600)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    assert.strictEqual(h.emitted.length, 2)
    assert.strictEqual(h.emitted[1].agentSpeech.startTime, 1003050)
  })

  it('ignores a repeated start within consecutive response playback', () => {
    const h = harness({ retain: false })
    h.start('r1', ['a1'])
    h.clock.tick(1000)
    h.send({ type: 'output_audio_buffer.started', response_id: 'r1' })
    assert.strictEqual(h.emitted.length, 0)
    h.clock.tick(2050)
    h.start('r2', ['a2'])
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].agentSpeech.startTime, 1000000)
    assert.strictEqual(h.emitted[0].agentSpeech.finishTime, 1003050)
    h.clock.tick(4600)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    assert.strictEqual(h.emitted.length, 2)
  })

  for (const lateRetrieval of [false, true]) {
    it('derives a shared playback window with a missing start (late retrieval=' + lateRetrieval + ')', () => {
      const h = harness()
      h.start('r1', ['a1'])
      h.retrieve('a1', 67200)
      h.clock.tick(1400)
      h.start('r2', ['a2'])
      h.start('r3', ['a3'], false)
      if (!lateRetrieval) {
        h.retrieve('a2', 100800)
        h.retrieve('a3', 196800)
      }
      h.clock.tick(6200)
      h.send({ type: 'output_audio_buffer.stopped', response_id: 'r3' })
      if (lateRetrieval) {
        assert.strictEqual(h.emitted.length, 1)
        h.retrieve('a3', 196800)
        assert.strictEqual(h.emitted.length, 1)
        h.retrieve('a2', 100800)
      }
      assert.strictEqual(h.emitted.length, 3)
      assert.deepStrictEqual(h.emitted.map(turn => turn.agentSpeech), [
        { startTime: 1000000, finishTime: 1001400, transcript: 'synthetic output' },
        { startTime: 1001400, finishTime: 1003500, transcript: 'synthetic output' },
        { startTime: 1003500, finishTime: 1007600, transcript: 'synthetic output' },
      ])
      assert.deepStrictEqual(h.emitted.map(turn => turn.output.audio.length), [67200, 100800, 196800])
      assert.strictEqual(h.emitted[0].metadata.agent_speech_timing, undefined)
      assert.ok(h.emitted.slice(1).every(turn => turn.metadata.agent_speech_timing === 'audio_duration'))
    })
  }

  it('derives a shared playback window after the final generation completes', () => {
    const h = harness()
    h.start('r1', ['a1'])
    h.retrieve('a1')
    h.send({ type: 'response.created', response: { id: 'r2' } })
    h.send({ type: 'response.output_item.added', response_id: 'r2', item: h.item('a2', 'in_progress') })
    h.clock.tick(2000)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    h.retrieve('a2')
    assert.strictEqual(h.emitted.length, 0)
    h.send({ type: 'response.done', response: { id: 'r2', status: 'completed', output: [h.item('a2')] } })
    h.clock.tick(0)
    h.retrieve('a2')
    assert.strictEqual(h.emitted.length, 2)
    assert.strictEqual(h.emitted[0].agentSpeech.finishTime, 1001000)
    assert.strictEqual(h.emitted[1].agentSpeech.startTime, 1001000)
  })

  it('releases shared playback members independently while an input transcript is pending', () => {
    const h = harness()
    h.send({ type: 'session.updated', session: { input_audio_transcription: { model: 'whisper-1' } } })
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.retrieveInput('u1')
    h.start('r1', ['a1'])
    h.start('r2', ['a2'], false)
    h.retrieve('a1')
    h.retrieve('a2')
    h.clock.tick(2000)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].agentSpeech.startTime, 1001000)
    h.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'late input' })
    assert.strictEqual(h.emitted.length, 2)
    assert.strictEqual(h.emitted[1].input.transcript, 'late input')
    assert.strictEqual(h.emitted[1].agentSpeech.startTime, 1000000)
    h.clock.tick(5000)
    assert.strictEqual(h.emitted.length, 2)
  })

  it('preserves a gap between the anchored clip and a derived trailing clip', () => {
    const h = harness()
    h.start('r1', ['a1'])
    h.retrieve('a1')
    h.start('r2', ['a2'], false)
    h.retrieve('a2')
    h.clock.tick(3000)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    assert.strictEqual(h.emitted.length, 2)
    assert.strictEqual(h.emitted[0].agentSpeech.finishTime, 1001000)
    assert.strictEqual(h.emitted[1].agentSpeech.startTime, 1002000)
  })

  it('derives multiple trailing clips within a shared playback window', () => {
    const h = harness()
    h.start('r1', ['a1'])
    h.start('r2', ['a2'], false)
    h.start('r3', ['a3'], false)
    for (const id of ['a1', 'a2', 'a3']) h.retrieve(id)
    h.clock.tick(3000)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r3' })
    assert.strictEqual(h.emitted.length, 3)
    assert.deepStrictEqual(h.emitted.map(turn => turn.agentSpeech.startTime), [1000000, 1001000, 1002000])
  })

  for (const elapsedMs of [1999, 1998]) {
    it('bounds shared playback clock rounding at ' + elapsedMs + 'ms', () => {
      const h = harness()
      h.start('r1', ['a1'])
      h.start('r2', ['a2'], false)
      h.retrieve('a1')
      h.retrieve('a2')
      h.clock.tick(elapsedMs)
      h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
      assert.strictEqual(h.emitted.length, 2)
      assert.ok(h.emitted.every(turn => Boolean(turn.agentSpeech) === (elapsedMs === 1999)))
    })
  }

  for (const invalid of ['missing', 'unknown-codec', 'incomplete', 'oversize']) {
    it('omits derived shared playback timing for ' + invalid + ' audio', () => {
      const h = harness()
      h.start('r1', ['a1'])
      h.start('r2', invalid === 'incomplete' ? ['a2', 'a3'] : ['a2'], false)
      h.retrieve('a1')
      if (invalid === 'missing' || invalid === 'incomplete') {
        if (invalid === 'incomplete') h.retrieve('a2')
        const itemId = invalid === 'incomplete' ? 'a3' : 'a2'
        const request = h.requests.find(request => request.itemId === itemId)
        h.send({ type: 'error', error: { event_id: request.eventId, code: 'item_unavailable' } })
      } else if (invalid === 'unknown-codec') {
        h.send({
          type: 'conversation.item.retrieved',
          item: { ...h.item('a2'), content: [{ type: 'output_audio', format: 'unknown', audio: 'AQI=' }] },
        })
      } else h.retrieve('a2', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES + 1)
      h.clock.tick(2000)
      h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
      assert.strictEqual(h.emitted.length, 2)
      assert.ok(h.emitted.every(turn => turn.agentSpeech === undefined))
      assert.ok(h.emitted.every(turn => turn.metadata.agent_speech_timing === undefined))
    })
  }

  it('flushes a shared playback window without deriving timing when retrieval never returns', () => {
    const h = harness()
    h.start('r1', ['a1'])
    h.start('r2', ['a2'], false)
    h.retrieve('a1')
    h.clock.tick(2000)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
    h.clock.tick(5000)
    assert.strictEqual(h.emitted.length, 2)
    assert.ok(h.emitted.every(turn => turn.agentSpeech === undefined))
    h.retrieve('a2')
    assert.strictEqual(h.emitted.length, 2)
  })

  it('does not treat an out-of-band response as queued behind active playback', () => {
    const h = harness()
    h.start('playing', ['a1'])
    h.retrieve('a1', 480000)
    h.clock.tick(100)
    h.start('out-of-band', ['a2'], false, { conversation_id: null })
    h.retrieve('a2')
    h.clock.tick(4999)
    assert.strictEqual(h.emitted.length, 0)
    h.clock.tick(1)
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].agentSpeech, undefined)
    h.clock.tick(4900)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'playing' })
    assert.strictEqual(h.emitted.length, 2)
    assert.strictEqual(h.emitted[1].output.audio.length, 480000)
  })

  for (const terminal of ['stopped', 'cleared']) {
    it('bounds unstarted queued audio after active playback is ' + terminal, () => {
      const h = harness()
      h.start('playing', ['a1'])
      h.retrieve('a1')
      h.clock.tick(100)
      h.start('queued', ['a2'], false)
      h.retrieve('a2')
      h.clock.tick(900)
      h.send({ type: 'output_audio_buffer.' + terminal, response_id: 'playing' })
      if (terminal === 'cleared') {
        h.send({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 1000 })
        h.clock.tick(0)
        h.retrieve('a1')
      }
      assert.strictEqual(h.emitted.length, 1)
      h.clock.tick(4000)
      h.retrieve('a2')
      h.clock.tick(999)
      assert.strictEqual(h.emitted.length, 1)
      h.clock.tick(1)
      assert.strictEqual(h.emitted.length, 2)
      assert.strictEqual(h.emitted[1].output.audio.length, 0)
      assert.strictEqual(h.emitted[1].agentSpeech, undefined)
    })
  }

  it('starts a fresh bounded playback wait when queued audio actually starts', () => {
    const h = harness({ retain: false })
    h.start('playing', ['a1'])
    h.clock.tick(100)
    h.start('queued', ['a2'], false)
    h.clock.tick(119899)
    h.send({ type: 'output_audio_buffer.started', response_id: 'queued' })
    assert.strictEqual(h.emitted.length, 1)
    h.clock.tick(6000)
    assert.strictEqual(h.emitted.length, 1)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'queued' })
    assert.strictEqual(h.emitted.length, 2)
    assert.ok(h.emitted[1].agentSpeech)
  })

  for (const delayedFirstRetrieval of [false, true]) {
    it('preserves later queued playback across a handoff (delayed retrieval=' + delayedFirstRetrieval + ')', () => {
      const h = harness()
      h.start('r1', ['a1'])
      if (!delayedFirstRetrieval) h.retrieve('a1')
      h.start('r2', ['a2'], false)
      h.retrieve('a2', 480000)
      h.start('r3', ['a3'], false)
      h.retrieve('a3')
      h.clock.tick(1000)
      h.send({ type: 'output_audio_buffer.started', response_id: 'r2' })
      if (delayedFirstRetrieval) h.retrieve('a1')
      assert.strictEqual(h.emitted.length, 1, 'only the earlier completed response can finish at handoff')
      h.clock.tick(6000)
      assert.strictEqual(h.emitted.length, 1, 'the third response remains queued while the second plays')
      h.send({ type: 'output_audio_buffer.started', response_id: 'r3' })
      assert.strictEqual(h.emitted.length, 2)
      h.clock.tick(1000)
      h.send({ type: 'output_audio_buffer.stopped', response_id: 'r3' })
      assert.strictEqual(h.emitted.length, 3)
      assert.strictEqual(h.emitted[2].output.audio.length, 48000)
      assert.deepStrictEqual(h.emitted[2].agentSpeech, {
        startTime: 1007000, finishTime: 1008000, transcript: 'synthetic output',
      })
    })
  }

  it('flushes active and unstarted queued audio on disconnect', () => {
    const h = harness()
    h.start('playing', ['a1'])
    h.start('queued', ['a2'], false)
    h.retrieve('a1')
    h.retrieve('a2')
    h.session.finishSession(h.clock.now)
    assert.strictEqual(h.emitted.length, 2)
    assert.ok(h.emitted.every(turn => turn.output.audio.length === 0 && turn.agentSpeech === undefined))
    h.clock.tick(120000)
    assert.strictEqual(h.emitted.length, 2)
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
    for (let i = 0; i < 15; i++) h.start('held-' + i, ['audio-' + i], false)
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

  for (const beforeDone of [true, false]) {
    it('releases a retrieved pending transcript (before done=' + beforeDone + ')', () => {
      const h = harness()
      h.send({ type: 'session.updated', session: { input_audio_transcription: { model: 'whisper-1' } } })
      h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
      h.send({ type: 'response.created', response: { id: 'r1' } })
      const retrieve = () => h.send({
        type: 'conversation.item.retrieved',
        item: { id: 'u1', role: 'user', content: [{ type: 'input_audio', transcript: 'retrieved text' }] },
      })
      if (beforeDone) retrieve()
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
      if (!beforeDone) {
        assert.strictEqual(h.emitted.length, 0)
        retrieve()
      }
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].input.transcript, 'retrieved text')
      h.clock.tick(5000)
      assert.strictEqual(h.emitted.length, 1)
    })
  }

  for (const extra of [0, 1]) {
    it('checks aggregate part size before decoding (extra=' + extra + ')', () => {
      const h = harness()
      h.start()
      const part = bytes => ({ type: 'output_audio', format: 'pcm16', audio: Buffer.alloc(bytes).toString('base64') })
      const content = [part(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES / 2),
        part(LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES / 2 + extra)]
      const decode = sinon.spy(Buffer, 'allocUnsafeSlow')
      h.send({ type: 'conversation.item.retrieved', item: { ...h.item('a1'), content } })
      h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
      assert.strictEqual(decode.callCount, extra ? 0 : 2)
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].output.audio.length, extra ? 0 : LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
      assert.strictEqual(h.emitted[0].output.audioPresent, true)
    })
  }

  it('includes existing output items in the pre-decode audio budget', () => {
    const h = harness()
    h.start('r1', ['a1', 'a2'])
    h.retrieve('a1', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    const audio = Buffer.alloc(1).toString('base64')
    const decode = sinon.spy(Buffer, 'allocUnsafeSlow')
    h.send({
      type: 'conversation.item.retrieved',
      item: {
        ...h.item('a2'), content: [{ type: 'output_audio', format: 'pcm16', audio }],
      },
    })
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(decode.callCount, 0)
    assert.strictEqual(h.emitted[0].output.audio.length, 0)
    assert.strictEqual(h.emitted[0].output.audioPresent, true)
  })

  it('replaces the speech window when a later VAD item supersedes a committed input', () => {
    const h = harness()
    const vad = (type, id, offset) => h.send({
      type: 'input_audio_buffer.speech_' + type,
      item_id: id,
      [type === 'started' ? 'audio_start_ms' : 'audio_end_ms']: offset,
    })
    vad('started', 'u1', 0)
    h.clock.tick(1000)
    vad('stopped', 'u1', 1000)
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.clock.tick(2000)
    vad('started', 'u2', 3000)
    h.clock.tick(1000)
    vad('stopped', 'u2', 4000)
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u2' })
    h.clock.tick(100)
    vad('stopped', 'u1', 9000)
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({
      type: 'conversation.item.retrieved',
      item: {
        id: 'u2',
        role: 'user',
        content: [{
          type: 'input_audio', format: 'pcm16', audio: Buffer.alloc(48000).toString('base64'), transcript: 'latest',
        }],
      },
    })
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].userSpeech.startTime, 1003000)
    assert.strictEqual(h.emitted[0].userSpeech.finishTime, 1004000)
    assert.strictEqual(h.emitted[0].llm.startTime, 1004000)
  })

  it('advances current-item VAD stops but ignores stale and backward offsets', () => {
    const h = harness()
    h.send({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 })
    h.clock.tick(1000)
    h.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1000 })
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.clock.tick(1000)
    h.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 2000 })
    h.clock.tick(500)
    for (const end of [2000, 1500]) {
      h.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: end })
    }
    h.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'older', audio_end_ms: 9000 })
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    assert.strictEqual(h.emitted[0].llm.startTime, 1002000)
  })

  for (const codec of [
    { format: 'pcm16', bytes: 48000 },
    { format: 'g711_ulaw', bytes: 8000 },
    { format: 'g711_alaw', bytes: 8000 },
  ]) {
    it('anchors manual sideband input to its commit using retrieved ' + codec.format + ' audio', () => {
      const h = harness()
      h.clock.tick(2000)
      h.send({ type: 'input_audio_buffer.committed', item_id: 'manual1' })
      h.clock.tick(500)
      h.send({
        type: 'conversation.item.retrieved',
        item: {
          id: 'manual1',
          role: 'user',
          content: [{
            type: 'input_audio',
            format: codec.format,
            audio: Buffer.alloc(codec.bytes).toString('base64'),
            transcript: 'manual input',
          }],
        },
      })
      h.send({ type: 'response.created', response: { id: 'r1' } })
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
      assert.strictEqual(h.emitted.length, 1)
      assert.deepStrictEqual(h.emitted[0].userSpeech, {
        startTime: 1001000, finishTime: 1002000, transcript: 'manual input',
      })
      assert.strictEqual(h.emitted[0].root.startTime, 1001000)
      assert.strictEqual(h.emitted[0].llm.startTime, 1002000)
      assert.strictEqual(h.emitted[0].input.audio.length, codec.bytes)
    })
  }

  for (const [name, expectedParts, content] of [
    ['empty', 1, [{ type: 'input_audio', format: 'pcm16', audio: '' }]],
    ['unsupported', 1, [{ type: 'input_audio', format: 'opus', audio: Buffer.alloc(100).toString('base64') }]],
    ['incomplete', 2, [{ type: 'input_audio', format: 'pcm16', audio: Buffer.alloc(48000).toString('base64') }]],
  ]) {
    it('omits unanchored manual speech for ' + name + ' retrieved audio', () => {
      const h = harness()
      h.send({ type: 'input_audio_buffer.committed', item_id: 'manual1' })
      h.send({
        type: 'conversation.item.done',
        item: {
          id: 'manual1', role: 'user', content: Array.from({ length: expectedParts }, () => ({ type: 'input_audio' })),
        },
      })
      h.send({ type: 'response.created', response: { id: 'r1' } })
      h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
      h.send({ type: 'conversation.item.retrieved', item: { id: 'manual1', role: 'user', content } })
      h.clock.tick(5000)
      assert.strictEqual(h.emitted.length, 1)
      assert.strictEqual(h.emitted[0].userSpeech, undefined)
      assert.strictEqual(h.emitted[0].root.startTime, 1000000)
      assert.strictEqual(h.emitted[0].llm.startTime, 1000000)
    })
  }

  it('uses the latest manual commit while preserving pending text and tool results', () => {
    const h = harness()
    h.session.onClientEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'context' }],
      },
    }, h.clock.now)
    h.session.onClientEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output', call_id: 'call1', output: 'result',
      },
    }, h.clock.now)
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.clock.tick(2000)
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u2' })
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    assert.strictEqual(h.emitted[0].llm.startTime, 1002000)
    assert.strictEqual(h.emitted[0].input.text, 'context')
    assert.strictEqual(h.emitted[0].input.toolResults[0].result, 'result')
  })

  it('keeps waiting when retrieval has no transcript', () => {
    const h = harness()
    h.send({ type: 'session.updated', session: { input_audio_transcription: { model: 'whisper-1' } } })
    h.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    h.retrieveInput('u1', 24000)
    assert.strictEqual(h.emitted.length, 0)
    h.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'ASR' })
    assert.strictEqual(h.emitted.length, 1)
    assert.strictEqual(h.emitted[0].input.transcript, 'ASR')
    assert.strictEqual(h.emitted[0].input.audio.length, 24000)
  })

  it('subtracts replaced audio parts from the decode budget', () => {
    const h = harness()
    h.start()
    h.retrieve('a1', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES, 1)
    h.retrieve('a1', LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES, 2)
    h.send({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    assert.strictEqual(h.emitted[0].output.audio.length, LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES)
    assert.strictEqual(h.emitted[0].output.audio[0], 2)
  })

  it('preserves active VAD timing when a manual commit assigns a different item ID', () => {
    const h = harness()
    h.send({ type: 'input_audio_buffer.speech_started', item_id: 'vad1', audio_start_ms: 0 })
    h.clock.tick(1000)
    h.send({ type: 'input_audio_buffer.committed', item_id: 'manual1' })
    h.send({ type: 'response.created', response: { id: 'r1' } })
    h.send({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    assert.strictEqual(h.emitted[0].userSpeech.startTime, 1000000)
    assert.strictEqual(h.emitted[0].userSpeech.finishTime, 1001000)
  })
})
