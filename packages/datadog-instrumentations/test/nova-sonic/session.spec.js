'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const SonicSession = require('../../src/nova-sonic/session')
const { INPUT, OUTPUT, EPOCH, event, pcm, record, fixture, speech } = require('./helpers')

function replay (records) {
  const emitted = []
  const session = new SonicSession(turn => emitted.push(turn))
  for (const r of records) session.observe(r.value, r.outbound, EPOCH + r.at)
  session.finish(undefined, EPOCH + (records.at(-1)?.at ?? 0))
  session.finish()
  return emitted
}

describe('Nova Sonic protocol', () => {
  for (const [name, count] of [['voice-session-1', 5], ['voice-session-2', 6]]) {
    it(`replays ${name} with local turns and reconciled cumulative usage`, () => {
      const { records, capture } = fixture(name)
      const emitted = replay(records)
      assert.equal(emitted.length, count)
      assert.equal(new Set(emitted.map(t => t.sessionId)).size, 1)
      assert.equal(new Set(emitted.map(t => t.turn.completionId)).size, 1)
      const totals = emitted.reduce((totals, { turn }) => {
        for (const [key, count] of Object.entries(turn.metrics)) totals[key] = (totals[key] ?? 0) + count
        assert.ok(turn.metrics.input_audio_tokens <= turn.metrics.input_tokens)
        assert.ok(turn.metrics.output_audio_tokens <= turn.metrics.output_tokens)
        return totals
      }, {})
      assert.equal(totals.input_tokens, capture.input_tokens)
      assert.equal(totals.output_tokens, capture.output_tokens)
      const lastUsage = capture.events.filter(r => r.event.usageEvent).at(-1).event.usageEvent
      assert.equal(totals.input_audio_tokens, lastUsage.details.total.input.speechTokens)
      assert.equal(totals.output_audio_tokens, lastUsage.details.total.output.speechTokens)
      for (const { turn, metadata } of emitted) {
        assert.ok(turn.inputPcm.length > 0)
        assert.ok(turn.output.pcm().length > 0)
        assert.equal(metadata.ttfa_boundary, 'speech_end_event_receipt')
        assert.equal(turn.inputPcm.length,
          Math.floor((turn.windows.at(-1).end_ms - turn.windows[0].start_ms) * turn.inputRate / 1000) * 2)
        assert.ok(Math.abs(turn.output.pcm().length / (2 * turn.output.rate) * 1000 -
          (turn.output.end - turn.output.start)) < 0.001)
      }
    })
  }

  it('keeps the offset origin across content names and creates a fresh origin per connection', () => {
    const turns = replay([...speech(), ...speech({ id: '2', offset: 1000, at: 4000 })])
    assert.equal(turns.length, 2)
    for (const { turn } of turns) assert.equal(turn.inputPcm.length, 12_800)
    assert.equal(replay(speech())[0].turn.inputPcm.length, 12_800)
  })

  it('keeps late FINAL text with the preceding response and preserves repeated chunks', () => {
    const records = speech()
    records.splice(12, 0, record('userSpeechStart', { inputAudioOffsetMs: 700 }, 3055))
    records.splice(-1, 0, record('textOutput', { contentId: 'final1', content: 'answer 1' }, 3071))
    const turns = replay(records)
    assert.equal(turns[0].turn.finalText, 'answer 1answer 1')
    assert.equal(turns[1].turn.finalText, '')
    assert.equal(turns[1].turn.inputEnd, undefined)
  })

  it('stops tracing on an unverified prompt restart', () => {
    const records = speech()
    records.push(record('promptStart', { promptName: 'different' }, 4000, true), ...speech({ id: '2', at: 5000 }))
    assert.equal(replay(records).length, 1)
  })

  for (const malformed of [undefined, -1, NaN, Infinity, '100', true]) {
    it(`does not invent speech timing from an invalid offset (${malformed})`, () => {
      const records = speech().filter(r => !r.value.chunk.bytes.includes('userSpeechStart'))
      records.unshift(record('userSpeechStart', { inputAudioOffsetMs: malformed }, 0))
      assert.equal(replay(records)[0].turn.inputEnd, undefined)
    })
  }

  it('retains phase timing when input format is unusable', () => {
    const [{ turn }] = replay(speech({ input: { ...INPUT, sampleSizeBits: 8 } }))
    assert.equal(turn.inputPcm, undefined)
    assert.equal(turn.inputEnd, EPOCH + 2500)
    assert.equal(turn.output.start - turn.inputEnd, 500)
  })

  it('supports TOOL-role calls and correlates outbound tool results without splitting the response', () => {
    const records = speech()
    records.splice(9, 0,
      record('contentStart', { contentId: 'tool', role: 'TOOL', type: 'TOOL' }, 2600),
      record('toolUse', {
        contentId: 'tool', toolName: 'get_weather', toolUseId: 'call', content: '{"city":"Boston"}',
      }, 2610),
      record('contentEnd', { contentId: 'tool', stopReason: 'TOOL_USE' }, 2620),
      record('contentStart', {
        contentName: 'result', toolResultInputConfiguration: { toolUseId: 'call' },
      }, 2630, true),
      record('toolResult', { contentName: 'result', content: 'sunny' }, 2640, true),
      record('contentEnd', { contentName: 'result' }, 2650, true))
    const turns = replay(records)
    assert.equal(turns.length, 1)
    assert.deepEqual(turns[0].turn.tools, [{
      name: 'get_weather', arguments: { city: 'Boston' }, toolId: 'call', type: 'function',
    }])
    assert.equal(turns[0].turn.toolResults[0].toolResults[0].toolId, 'call')
  })

  for (const bad of [undefined, -1, true, '4', 1.5, NaN, Infinity, 11]) {
    it(`omits invalid audio token subsets (${bad}) without changing total usage`, () => {
      const [{ turn }] = replay([record('usageEvent', {
        totalInputTokens: 10,
        totalOutputTokens: 5,
        details: { total: { input: { speechTokens: bad }, output: { speechTokens: 3 } } },
      }, 0)])
      assert.deepEqual(turn.metrics, { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_audio_tokens: 3 })
    })
  }

  it('differences cumulative usage once and never adds speech tokens to the totals', () => {
    const usage = record('usageEvent', {
      totalInputTokens: 10,
      totalOutputTokens: 5,
      details: { total: { input: { speechTokens: 0 }, output: { speechTokens: 3 } } },
    }, 0)
    const [{ turn }] = replay([usage, usage])
    assert.deepEqual(turn.metrics, {
      input_tokens: 10, output_tokens: 5, total_tokens: 15, input_audio_tokens: 0, output_audio_tokens: 3,
    })
  })

  it('does not leak missing speech-token attribution into later turns', () => {
    const usage = (input, speech, at) => record('usageEvent', {
      totalInputTokens: input, totalOutputTokens: 0, details: { total: { input: { speechTokens: speech } } },
    }, at)
    const records = speech()
    records.splice(10, 0, usage(10, 8, 2701), usage(20, undefined, 2702), usage(30, 20, 2703))
    const next = speech({ id: '2', offset: 1000, at: 4000 })
    next.splice(9, 0, usage(40, 26, 6600))
    const turns = replay([...records, ...next])
    assert.equal(turns[0].turn.metrics.input_audio_tokens, undefined)
    assert.equal(turns[1].turn.metrics.input_audio_tokens, 6)
  })

  it('survives malformed event JSON and emits a partial error exactly once', () => {
    const emitted = []
    const session = new SonicSession(t => emitted.push(t))
    session.observe({ chunk: { bytes: Buffer.from('{broken') } }, false)
    session.observe(event('contentStart', { contentId: 't', role: 'ASSISTANT', type: 'TEXT' }), false, EPOCH)
    session.observe(event('textOutput', { contentId: 't', content: 'partial text' }), false, EPOCH)
    const error = new Error('provider failed')
    session.finish(error, EPOCH + 1)
    session.finish()
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].error, error)
    assert.equal(emitted[0].turn.speculativeText, 'partial text')
  })

  for (const late of ['valid', 'invalid', 'odd', 'rate', 'format']) {
    it(`ignores ${late} late audio after interruption without losing the retained clip`, () => {
      const records = speech({ outputMs: 2000 }).slice(0, 11)
      records.push(
        record('contentStart', {
          contentId: 'control', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: { generationStage: 'FINAL' },
        }, 3200),
        record('textOutput', { contentId: 'control', content: '{ "interrupted" : true }' }, 3250),
        record('contentStart', {
          contentId: 'late',
          role: 'ASSISTANT',
          type: 'AUDIO',
          audioOutputConfiguration: {
            ...OUTPUT,
            sampleRateHertz: late === 'rate' ? 48_000 : 24_000,
            mediaType: late === 'format' ? 'audio/mpeg' : 'audio/lpcm',
          },
        }, 3300),
        record('audioOutput', {
          contentId: 'late', content: late === 'invalid' ? 'invalid!' : late === 'odd' ? 'b2Rk' : pcm(100),
        }, 3350))
      const [{ turn }] = replay(records)
      assert.equal(turn.output.pcm().length, 12_000)
      assert.equal(turn.output.end, EPOCH + 3250)
      assert.equal(turn.output.omittedReason, undefined)
    })
  }
})
