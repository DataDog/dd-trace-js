'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const SonicSession = require('../../src/nova-sonic/session')
const { INPUT, OUTPUT, EPOCH, event, pcm, record, fixture, speech, namedUsage } = require('./helpers')

function replay (records) {
  const emitted = []
  const session = new SonicSession(turn => emitted.push(turn))
  for (const r of records) session.observe(r.value, r.outbound, EPOCH + r.at)
  session.finish(undefined, EPOCH + (records.at(-1)?.at ?? 0))
  session.finish()
  return emitted
}

function history (contents) {
  return contents.flatMap((content, index) => {
    const contentName = `history-${index}`
    return [
      record('contentStart', {
        contentName, role: index === 0 ? 'SYSTEM' : index % 2 ? 'USER' : 'ASSISTANT', type: 'TEXT', interactive: false,
      }, 0, true),
      record('textInput', { contentName, content }, 0, true),
      record('contentEnd', { contentName }, 0, true),
    ]
  })
}

describe('Nova Sonic protocol', () => {
  for (const count of [17, 128, 129]) {
    it(`captures resumed history within the message bound (${count} messages) without limiting live turns`, () => {
      const contents = Array.from({ length: count }, (_, index) => `message ${index}`)
      const turns = replay([
        ...history(contents), ...speech(), ...speech({ id: '2', offset: 1000, at: 4000 }),
      ])
      assert.equal(turns.length, 2)
      for (const [index, turn] of turns.entries()) {
        assert.deepEqual(turn.history.map(message => message.content), contents.slice(0, 128))
        assert.equal(turn.history[0].role, 'system')
        assert.equal(turn.turn.userText, `question ${index + 1}`)
      }
    })
  }

  for (const lastLength of [512, 513]) {
    it(`preserves the aggregate history text budget at ${127 * 512 + lastLength} code units`, () => {
      const contents = [...Array(127).fill('x'.repeat(512)), 'y'.repeat(lastLength)]
      const [turn] = replay([...history(contents), ...speech()])
      assert.equal(turn.history.length, 128)
      assert.equal(turn.history.reduce((length, message) => length + message.content.length, 0), 65_536)
      assert.equal(turn.history.at(-1).content, 'y'.repeat(512))
      assert.equal(turn.turn.userText, 'question 1')
    })
  }

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
      for (const direction of ['input', 'output']) {
        assert.equal(totals[`${direction}_audio_tokens`], lastUsage.details.total[direction].speechTokens)
        assert.equal(totals[`${direction}_text_tokens`], lastUsage.details.total[direction].textTokens)
        for (const { turn } of emitted) {
          assert.equal(turn.metrics[`${direction}_text_tokens`] + turn.metrics[`${direction}_audio_tokens`],
            turn.metrics[`${direction}_tokens`])
        }
      }
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
    assert.equal(turn.inputAudioObserved, true)
    assert.equal(turn.inputEnd, EPOCH + 2500)
    assert.equal(turn.output.start - turn.inputEnd, 500)
  })

  it('does not leak observed audio from a previous turn into a text-only turn', () => {
    const turns = replay([
      ...speech(),
      record('contentStart', { contentId: 'user2', role: 'USER', type: 'TEXT' }, 4000),
      record('textOutput', { contentId: 'user2', content: 'next question' }, 4010),
      record('contentEnd', { contentId: 'user2', stopReason: 'END_TURN' }, 4020),
      record('contentStart', { contentId: 'answer2', role: 'ASSISTANT', type: 'TEXT' }, 4100),
      record('textOutput', { contentId: 'answer2', content: 'next answer' }, 4110),
      record('contentEnd', { contentId: 'answer2', stopReason: 'END_TURN' }, 4120),
    ])
    assert.equal(turns.length, 2)
    assert.equal(turns[0].turn.inputAudioObserved, true)
    assert.equal(turns[0].turn.outputAudioObserved, true)
    assert.equal(turns[1].turn.inputAudioObserved, false)
    assert.equal(turns[1].turn.outputAudioObserved, false)
  })

  it('does not treat a user text ending as response completion', () => {
    const [result] = replay([
      record('contentStart', { contentId: 'assistant', role: 'ASSISTANT', type: 'TEXT' }, 100),
      record('textOutput', { contentId: 'assistant', content: 'partial' }, 110),
      record('contentEnd', { contentId: 'assistant', stopReason: 'PARTIAL_TURN' }, 120),
      record('contentStart', { contentId: 'user', role: 'USER', type: 'TEXT' }, 200),
      record('textOutput', { contentId: 'user', content: 'late user transcript' }, 210),
      record('contentEnd', { contentId: 'user', stopReason: 'END_TURN' }, 220),
      record('completionEnd', {}, 1000),
    ])
    assert.equal(result.responseEnd, EPOCH + 1000)
    assert.equal(result.metadata.partial, true)
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

  it('routes named cumulative deltas to their turns and ignores duplicate or stale usage', () => {
    const first = speech()
    const next = speech({ id: '2', offset: 1000, at: 4000 })
    const initial = namedUsage({
      input: 85, output: 129, inputText: 6, outputText: 24, inputAudio: 79, outputAudio: 105,
    }, 2600)
    const pending = namedUsage({
      input: 95, output: 139, inputText: 8, outputText: 28, inputAudio: 87, outputAudio: 111,
    }, 6600)
    const turns = replay([
      ...first.slice(0, 9), initial, initial, ...first.slice(9),
      ...next.slice(0, 9), pending, pending, { ...initial, at: 6601 }, ...next.slice(9),
      namedUsage({
        input: 95, output: 149, inputText: 8, outputText: 31, inputAudio: 87, outputAudio: 118,
      }, 7100),
    ])
    assert.deepEqual(turns.map(({ turn }) => turn.metrics), [
      {
        input_tokens: 85,
        output_tokens: 139,
        total_tokens: 224,
        input_text_tokens: 6,
        output_text_tokens: 28,
        input_audio_tokens: 79,
        output_audio_tokens: 111,
      },
      {
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 20,
        input_text_tokens: 2,
        output_text_tokens: 3,
        input_audio_tokens: 8,
        output_audio_tokens: 7,
      },
    ])
  })

  for (const direction of ['input', 'output']) {
    for (const bad of [undefined, null, -1, true, false, '2', 1.5, Number.MAX_SAFE_INTEGER + 1, 11]) {
      it(`omits invalid ${direction} text without discarding audio (${bad})`, () => {
        const [{ turn }] = replay([namedUsage({
          input: 10,
          output: 10,
          inputText: 2,
          outputText: 2,
          inputAudio: 8,
          outputAudio: 8,
          [`${direction}Text`]: bad,
        }, 0)])
        assert.equal(turn.metrics[`${direction}_text_tokens`], undefined)
        assert.equal(turn.metrics.input_audio_tokens, 8)
        assert.equal(turn.metrics.output_audio_tokens, 8)
        assert.equal(turn.metrics[`${direction === 'input' ? 'output' : 'input'}_text_tokens`], 2)
        assert.equal(turn.metrics.total_tokens, 20)
      })
    }

    for (const text of [2, 8]) {
      it(`validates the combined ${direction} audio/text delta (${text} text tokens)`, () => {
        const [{ turn }] = replay([namedUsage({
          input: 10,
          output: 10,
          inputText: 2,
          outputText: 2,
          inputAudio: 8,
          outputAudio: 8,
          [`${direction}Text`]: text,
        }, 0)])
        assert.equal(turn.metrics[`${direction}_text_tokens`], text === 2 ? 2 : undefined)
        assert.equal(turn.metrics.input_audio_tokens, 8)
        assert.equal(turn.metrics.output_audio_tokens, 8)
        assert.equal(turn.metrics[`${direction === 'input' ? 'output' : 'input'}_text_tokens`], 2)
        assert.equal(turn.metrics.total_tokens, 20)
      })
    }

    it(`omits conflicting ${direction} text for the turn and recovers subsequent deltas`, () => {
      const usage = (total, audio, text, at) => namedUsage({
        input: 0,
        output: 0,
        [direction]: total,
        [`${direction}Audio`]: audio,
        [`${direction}Text`]: text,
      }, at)
      const first = speech()
      first.splice(10, 0,
        usage(100, 10, 10, 2701), usage(110, 18, 18, 2702), usage(120, 26, 20, 2703))
      const next = speech({ id: '2', offset: 1000, at: 4000 })
      next.splice(10, 0, usage(130, 34, 22, 6701))
      const turns = replay([...first, ...next])
      assert.deepEqual(turns.map(({ turn }) => turn.metrics[`${direction}_text_tokens`]), [undefined, 2])
      assert.deepEqual(turns.map(({ turn }) => turn.metrics[`${direction}_audio_tokens`]), [26, 8])
      assert.deepEqual(turns.map(({ turn }) => turn.metrics[`${direction}_tokens`]), [120, 10])
    })

    it(`rejects ${direction} text deltas larger than the aggregate delta`, () => {
      const records = speech()
      records.splice(10, 0,
        namedUsage({
          input: 0,
          output: 0,
          [direction]: 10,
          [`${direction}Text`]: 2,
          [`${direction}Audio`]: 8,
        }, 2701),
        namedUsage({
          input: 0,
          output: 0,
          [direction]: 15,
          [`${direction}Text`]: 10,
          [`${direction}Audio`]: 13,
        }, 2702))
      const [{ turn }] = replay(records)
      assert.equal(turn.metrics[`${direction}_text_tokens`], undefined)
      assert.equal(turn.metrics[`${direction}_audio_tokens`], 13)
      assert.equal(turn.metrics[`${direction}_tokens`], 15)
    })

    for (const modality of ['Text', 'Audio']) {
      for (const missing of [undefined, -1, 3, 21]) {
        it(`rebases ${direction} ${modality} gaps independently across turns (${missing})`, () => {
          const other = modality === 'Text' ? 'Audio' : 'Text'
          const usage = (total, value, otherValue, at) => namedUsage({
            input: 0,
            output: 0,
            [direction]: total,
            [`${direction}${modality}`]: value,
            [`${direction}${other}`]: otherValue,
          }, at)
          const first = speech()
          first.splice(10, 0, usage(10, 6, 4, 2701), usage(20, missing, 8, 2702))
          const second = speech({ id: '2', offset: 1000, at: 4000 })
          second.splice(10, 0, usage(30, 16, 12, 6701))
          const third = speech({ id: '3', offset: 2000, at: 8000 })
          third.splice(10, 0, usage(40, 18, 16, 10701))
          const turns = replay([...first, ...second, ...third])
          assert.deepEqual(turns.map(({ turn }) => turn.metrics[`${direction}_${modality.toLowerCase()}_tokens`]),
            [undefined, undefined, 2])
          assert.deepEqual(turns.map(({ turn }) => turn.metrics[`${direction}_${other.toLowerCase()}_tokens`]),
            [8, 4, 4])
          assert.deepEqual(turns.map(({ turn }) => turn.metrics[`${direction}_tokens`]), [20, 10, 10])
        })
      }
    }
  }

  it('preserves the largest safe text count and explicit zero modality counts', () => {
    const [{ turn }] = replay([namedUsage({
      input: Number.MAX_SAFE_INTEGER,
      output: 0,
      inputText: Number.MAX_SAFE_INTEGER,
      inputAudio: 0,
      outputText: 0,
      outputAudio: 0,
    }, 0)])
    assert.deepEqual(turn.metrics, {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER,
      input_text_tokens: Number.MAX_SAFE_INTEGER,
      input_audio_tokens: 0,
      output_text_tokens: 0,
      output_audio_tokens: 0,
    })
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
        record('contentEnd', { contentId: 'control', stopReason: 'INTERRUPTED' }, 3251),
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
