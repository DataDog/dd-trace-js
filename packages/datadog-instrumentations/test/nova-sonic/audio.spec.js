'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const { InputAudio, OutputAudio } = require('../../src/nova-sonic/audio')
const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')
const { INPUT, OUTPUT, pcm } = require('./helpers')

const LIMIT = LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES - 128

describe('Nova Sonic PCM retention', () => {
  for (const length of [LIMIT - 2, LIMIT, LIMIT + 2, LIMIT + 4, LIMIT * 2]) {
    it(`bounds input decoding before allocation (${length} bytes)`, () => {
      const input = new InputAudio()
      input.configure(INPUT)
      const raw = Buffer.alloc(length, 1)
      raw.writeUInt16LE(513, raw.length - 2)
      const encoded = raw.toString('base64')
      const from = sinon.spy(Buffer, 'from')
      try {
        input.append(encoded, 100_000)
        const decodes = from.getCalls().filter(call => call.args[1] === 'base64')
        assert.equal(decodes.length, 1)
        assert.ok(decodes[0].returnValue.length <= LIMIT + 2)
      } finally {
        from.restore()
      }
      assert.equal(input.total, length)
      assert.equal(input.anchor, 100_000 - length / 32)
      const start = Math.max(0, length - LIMIT)
      assert.deepEqual(input.clip(start / 32, length / 32), raw.subarray(start))
      input.append('AgA=', 100_001)
      assert.deepEqual(input.clip(length / 32, (length + 2) / 32), Buffer.from([2, 0]))
    })
  }

  for (const kind of ['oversized', 'overflowed', 'interrupted', 'odd', 'invalid-format']) {
    it(`does not decode discarded output (${kind})`, () => {
      const output = new OutputAudio()
      if (kind === 'overflowed') output.append(Buffer.alloc(LIMIT + 2).toString('base64'), OUTPUT, 1000)
      if (kind === 'interrupted') output.interrupt(1000)
      const length = kind === 'odd' ? LIMIT + 1 : LIMIT + 2
      const encoded = Buffer.alloc(length).toString('base64')
      const from = sinon.spy(Buffer, 'from')
      try {
        output.append(encoded, kind === 'invalid-format' ? {} : OUTPUT, 1001)
        assert.equal(from.getCalls().filter(call => call.args[1] === 'base64').length, 0)
      } finally {
        from.restore()
      }
      assert.equal(output.generatedBytes, length + (kind === 'overflowed' ? LIMIT + 2 : 0))
      assert.equal(output.pcm(), undefined)
      if (kind === 'oversized' || kind === 'overflowed') {
        assert.equal(output.timingValid, true)
        assert.equal(output.omittedReason, 'retention_limit')
      }
    })
  }

  for (const encoded of ['AA==', 'AAA=', 'AAAA', 'AAAAAA==', 'AAAAAAAA']) {
    it(`accounts for base64 padding without decoding invalid PCM (${encoded})`, () => {
      const raw = Buffer.from(encoded, 'base64')
      const input = new InputAudio()
      input.configure(INPUT)
      input.append(encoded, 1000)
      assert.equal(input.total, raw.length)
      assert.equal(input.valid, raw.length % 2 === 0)
      const output = new OutputAudio()
      output.append(encoded, OUTPUT, 1000)
      assert.equal(output.generatedBytes, raw.length)
      assert.equal(output.timingValid, raw.length % 2 === 0)
      if (output.timingValid) assert.deepEqual(output.pcm(), raw)
    })
  }

  for (const encoded of ['A===', 'AA=A', '====', 'AAA\n', 'AAA\r', 'AAA\u2028', 'AAA\u2029', 'AA!A']) {
    it(`rejects malformed base64 before allocating (${JSON.stringify(encoded)})`, () => {
      const input = new InputAudio()
      input.configure(INPUT)
      const output = new OutputAudio()
      const from = sinon.spy(Buffer, 'from')
      try {
        input.append(encoded, 0)
        output.append(encoded, OUTPUT, 0)
        assert.equal(from.getCalls().filter(call => call.args[1] === 'base64').length, 0)
      } finally {
        from.restore()
      }
      assert.equal(input.valid, false)
      assert.equal(output.timingValid, false)
      assert.equal(output.generatedBytes, 0)
    })
  }

  for (const rate of [8000, 16_000, 24_000, 48_000]) {
    it(`copies exact input samples across chunk boundaries at ${rate}Hz`, () => {
      const audio = new InputAudio()
      audio.configure({ ...INPUT, sampleRateHertz: rate })
      const raw = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
      for (const chunk of [raw.subarray(0, 8), raw.subarray(8, 20), raw.subarray(20)]) {
        audio.append(chunk.toString('base64'), 1000)
      }
      // Whole clip, interior chunk, partial ends, exact boundary, and sub-frame empty slice.
      for (const [start, end] of [[0, 16], [4, 10], [2, 13], [10, 16], [12.1, 12.2]]) {
        const clip = audio.clip(start * 1000 / rate, end * 1000 / rate)
        const expected = raw.subarray(Math.floor(start) * 2, Math.floor(end) * 2)
        assert.deepEqual(clip, expected)
        clip.fill(255)
        assert.deepEqual(audio.clip(start * 1000 / rate, end * 1000 / rate), expected)
      }
      assert.equal(audio.clip(-1000 / rate, 1000 / rate), undefined)
      assert.equal(audio.clip(0, 17 * 1000 / rate), undefined)
      assert.equal(audio.clip(1, 1), undefined)
    })
  }

  it('copies a clip across a partially evicted chunk and the next chunk', () => {
    const audio = new InputAudio()
    audio.configure(INPUT)
    audio.append(Buffer.alloc(LIMIT - 4, 1).toString('base64'), 1000)
    audio.append(Buffer.alloc(8, 2).toString('base64'), 1001)
    const start = (LIMIT - 8) / 32
    assert.deepEqual(audio.clip(start, (LIMIT + 4) / 32), Buffer.from([1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]))
    assert.equal(audio.clip(0, 1 / 16), undefined)
    assert.deepEqual(audio.clip(4 / 32, 8 / 32), Buffer.alloc(4, 1))
  })

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
