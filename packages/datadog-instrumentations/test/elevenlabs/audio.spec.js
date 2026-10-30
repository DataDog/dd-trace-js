'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { AudioBuffer, RAW_LIMIT } = require('../../src/elevenlabs/audio')

describe('ElevenLabs PCM accumulation', () => {
  it('accepts the last full clip and discards the whole clip at the first excess sample', () => {
    const audio = new AudioBuffer()
    const last = Buffer.alloc(RAW_LIMIT, 7)
    audio.append(last.toString('base64'), 1000, 16000, true, true)
    assert.deepEqual(audio.bytes(), last)
    assert.equal(audio.overflow, false)
    audio.append(Buffer.alloc(2).toString('base64'), 1001, 16000, true, true)
    assert.equal(audio.bytes().length, 0)
    assert.equal(audio.overflow, true)
  })
  it('rejects malformed and partial PCM samples without corrupting a valid clip', () => {
    const audio = new AudioBuffer()
    for (const encoded of ['$', 'AA', 'AA==', '====', true, null]) audio.append(encoded, 0, 16000, true, true)
    assert.equal(audio.total, 0)
    audio.append('AAAAAA==', 2, 16000, true, true)
    assert.deepEqual(audio.bytes(), Buffer.alloc(4))
  })
  it('counts sample placement without allocating decoded audio for an APM-only consumer', () => {
    const audio = new AudioBuffer()
    audio.append(Buffer.alloc(320).toString('base64'), 100, 16000, true, false)
    assert.equal(audio.bytes().length, 0)
    assert.equal(audio.start, 90)
    assert.equal(audio.end(16000), 100)
  })
  it('cuts output at a sample boundary', () => {
    const audio = new AudioBuffer()
    audio.append(Buffer.alloc(4800, 9).toString('base64'), 100, 24000, false, true)
    audio.trim(130.01, 24000)
    assert.equal(audio.bytes().length, 1440)
    assert.equal(audio.end(24000), 130)
  })
})
