'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { InputAudio, OutputAudio } = require('../../src/nova-sonic/audio')
const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')
const { INPUT, OUTPUT, pcm } = require('./helpers')

const LIMIT = LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES - 128

describe('Nova Sonic PCM retention', () => {
  it('retains a complete input clip at the ring boundary and omits the first evicted sample', () => {
    const audio = new InputAudio()
    audio.configure(INPUT)
    audio.append(Buffer.alloc(LIMIT).toString('base64'), 100_000)
    assert.equal(audio.clip(0, LIMIT / 32).length, LIMIT)
    audio.append('AAA=', 100_001)
    assert.equal(audio.clip(0, LIMIT / 32), undefined)
    assert.equal(audio.clip(1 / 16, (LIMIT + 2) / 32).length, LIMIT)
  })

  it('drops the whole output clip at the first sample over the cap and preserves timing', () => {
    const audio = new OutputAudio()
    audio.append(Buffer.alloc(LIMIT).toString('base64'), OUTPUT, 1000)
    assert.equal(audio.pcm().length, LIMIT)
    audio.append('AAA=', OUTPUT, 1001)
    assert.equal(audio.pcm(), undefined)
    assert.equal(audio.omittedReason, 'retention_limit')
    assert.equal(audio.timingValid, true)
    assert.equal(Math.round((audio.end - audio.start) * 48), LIMIT + 2)
  })

  for (const rate of [8000, 16_000, 24_000, 48_000]) {
    it(`cuts whole PCM frames and serializes queued chunks at ${rate}Hz`, () => {
      const audio = new OutputAudio()
      const format = { ...OUTPUT, sampleRateHertz: rate }
      audio.append(pcm(1000, rate), format, 1000)
      audio.append(pcm(1000, rate), format, 1100)
      assert.equal(audio.end, 3000)
      audio.interrupt(1250)
      assert.equal(audio.pcm().length, rate / 2)
      assert.equal(audio.end, 1250)
    })
  }

  for (const content of ['invalid!', 'b2Rk']) {
    it(`omits malformed ${content} audio without shifting later input offsets`, () => {
      const input = new InputAudio()
      input.configure(INPUT)
      input.append(content, 0)
      input.append(pcm(1000, 16_000), 1000)
      assert.equal(input.clip(100, 500), undefined)
      const output = new OutputAudio()
      output.append(pcm(100), OUTPUT, 1000)
      output.append(content, OUTPUT, 1001)
      assert.equal(output.pcm(), undefined)
      assert.equal(output.timingValid, false)
    })
  }

  it('omits format changes instead of guessing sample offsets', () => {
    const audio = new InputAudio()
    audio.configure(INPUT)
    audio.append(pcm(1000, 16_000), 1000)
    audio.configure(OUTPUT)
    audio.append(pcm(1000), 2000)
    assert.equal(audio.clip(100, 500), undefined)
  })
})
