'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  bytesPerSecond,
  g711ToPcm16,
  g711Variant,
  isPcm16AudioMime,
  pcm16ToWav,
  realtimeAudioFormatToMime,
  segmentDurationMs,
} = require('../../src/llmobs/audio-codec')

describe('audio-codec', () => {
  describe('realtimeAudioFormatToMime', () => {
    it('maps the legacy string formats', () => {
      assert.strictEqual(realtimeAudioFormatToMime('pcm16'), 'audio/pcm')
      assert.strictEqual(realtimeAudioFormatToMime('pcm'), 'audio/pcm')
      assert.strictEqual(realtimeAudioFormatToMime('g711_ulaw'), 'audio/pcmu')
      assert.strictEqual(realtimeAudioFormatToMime('g711_alaw'), 'audio/pcma')
    })

    it('reads the discriminated-union object form, whose type is already a MIME type', () => {
      assert.strictEqual(realtimeAudioFormatToMime({ type: 'audio/pcm' }), 'audio/pcm')
      assert.strictEqual(realtimeAudioFormatToMime({ type: 'audio/pcmu' }), 'audio/pcmu')
    })

    it('passes an unrecognized format through as audio/<format>', () => {
      assert.strictEqual(realtimeAudioFormatToMime('flac'), 'audio/flac')
    })

    it('normalizes whitespace and case', () => {
      assert.strictEqual(realtimeAudioFormatToMime('  PCM16 '), 'audio/pcm')
      assert.strictEqual(realtimeAudioFormatToMime({ type: ' AUDIO/PCMA ' }), 'audio/pcma')
    })

    it('returns an empty string when the format is absent or unusable', () => {
      assert.strictEqual(realtimeAudioFormatToMime(undefined), '')
      assert.strictEqual(realtimeAudioFormatToMime(null), '')
      assert.strictEqual(realtimeAudioFormatToMime(''), '')
      assert.strictEqual(realtimeAudioFormatToMime('   '), '')
      assert.strictEqual(realtimeAudioFormatToMime({}), '')
      assert.strictEqual(realtimeAudioFormatToMime(5), '')
    })

    it('does not resolve a format off Object.prototype', () => {
      assert.strictEqual(realtimeAudioFormatToMime('constructor'), 'audio/constructor')
      assert.strictEqual(realtimeAudioFormatToMime('__proto__'), 'audio/__proto__')
    })
  })

  describe('isPcm16AudioMime', () => {
    it('recognizes the raw little-endian PCM16 types', () => {
      assert.strictEqual(isPcm16AudioMime('audio/pcm'), true)
      assert.strictEqual(isPcm16AudioMime('audio/pcm16'), true)
      assert.strictEqual(isPcm16AudioMime('audio/l16'), true)
      assert.strictEqual(isPcm16AudioMime(' AUDIO/PCM '), true)
    })

    it('rejects everything else', () => {
      assert.strictEqual(isPcm16AudioMime('audio/wav'), false)
      assert.strictEqual(isPcm16AudioMime('audio/pcmu'), false)
      assert.strictEqual(isPcm16AudioMime(''), false)
      assert.strictEqual(isPcm16AudioMime(undefined), false)
    })
  })

  describe('g711Variant', () => {
    it('maps both spellings of each variant', () => {
      assert.strictEqual(g711Variant('audio/pcmu'), 'ulaw')
      assert.strictEqual(g711Variant('audio/g711_ulaw'), 'ulaw')
      assert.strictEqual(g711Variant('audio/pcma'), 'alaw')
      assert.strictEqual(g711Variant('audio/g711_alaw'), 'alaw')
    })

    it('returns undefined for any other format', () => {
      assert.strictEqual(g711Variant('audio/pcm'), undefined)
      assert.strictEqual(g711Variant(''), undefined)
      assert.strictEqual(g711Variant(undefined), undefined)
    })
  })

  describe('g711ToPcm16', () => {
    // The CCITT G.711 extremes and zero points. These pin the decode tables against the standard
    // rather than against our own implementation.
    it('decodes mu-law to its canonical range', () => {
      const decoded = g711ToPcm16(Buffer.from([0x00, 0x80, 0x7F, 0xFF]), 'ulaw')
      assert.strictEqual(decoded.length, 8)
      assert.strictEqual(decoded.readInt16LE(0), -32_124)
      assert.strictEqual(decoded.readInt16LE(2), 32_124)
      assert.strictEqual(decoded.readInt16LE(4), 0)
      assert.strictEqual(decoded.readInt16LE(6), 0)
    })

    it('decodes A-law to its canonical range', () => {
      const decoded = g711ToPcm16(Buffer.from([0x2A, 0xAA, 0x55, 0xD5]), 'alaw')
      assert.strictEqual(decoded.length, 8)
      assert.strictEqual(decoded.readInt16LE(0), -32_256)
      assert.strictEqual(decoded.readInt16LE(2), 32_256)
      assert.strictEqual(decoded.readInt16LE(4), -8)
      assert.strictEqual(decoded.readInt16LE(6), 8)
    })

    it('produces two bytes per input byte', () => {
      assert.strictEqual(g711ToPcm16(Buffer.alloc(160), 'ulaw').length, 320)
    })

    it('decodes an empty buffer to an empty buffer', () => {
      assert.strictEqual(g711ToPcm16(Buffer.alloc(0), 'ulaw').length, 0)
    })
  })

  describe('pcm16ToWav', () => {
    it('prepends a well-formed 44-byte RIFF header', () => {
      const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04])
      const wav = pcm16ToWav(pcm, 24_000)

      assert.strictEqual(wav.length, 48)
      assert.strictEqual(wav.toString('latin1', 0, 4), 'RIFF')
      assert.strictEqual(wav.readUInt32LE(4), 40) // 36 + data length
      assert.strictEqual(wav.toString('latin1', 8, 12), 'WAVE')
      assert.strictEqual(wav.toString('latin1', 12, 16), 'fmt ')
      assert.strictEqual(wav.readUInt32LE(16), 16) // fmt chunk size
      assert.strictEqual(wav.readUInt16LE(20), 1) // uncompressed PCM
      assert.strictEqual(wav.readUInt16LE(22), 1) // channels
      assert.strictEqual(wav.readUInt32LE(24), 24_000) // sample rate
      assert.strictEqual(wav.readUInt32LE(28), 48_000) // byte rate
      assert.strictEqual(wav.readUInt16LE(32), 2) // block align
      assert.strictEqual(wav.readUInt16LE(34), 16) // bits per sample
      assert.strictEqual(wav.toString('latin1', 36, 40), 'data')
      assert.strictEqual(wav.readUInt32LE(40), 4) // data length
    })

    it('is lossless — the samples follow the header untouched', () => {
      const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04])
      assert.deepStrictEqual(pcm16ToWav(pcm).subarray(44), pcm)
    })

    it('honors the G.711 rate and reflects it in the byte rate', () => {
      const wav = pcm16ToWav(Buffer.alloc(16), 8000)
      assert.strictEqual(wav.readUInt32LE(24), 8000)
      assert.strictEqual(wav.readUInt32LE(28), 16_000)
    })

    it('handles empty audio without producing a malformed header', () => {
      const wav = pcm16ToWav(Buffer.alloc(0))
      assert.strictEqual(wav.length, 44)
      assert.strictEqual(wav.readUInt32LE(4), 36)
      assert.strictEqual(wav.readUInt32LE(40), 0)
    })
  })

  describe('bytesPerSecond', () => {
    it('is two bytes per sample for PCM16 at the session rate', () => {
      assert.strictEqual(bytesPerSecond('audio/pcm', 24_000), 48_000)
      assert.strictEqual(bytesPerSecond('audio/pcm', 16_000), 32_000)
    })

    it('is the fixed 8 kHz rate for G.711, ignoring the session rate', () => {
      assert.strictEqual(bytesPerSecond('audio/pcmu', 24_000), 8000)
      assert.strictEqual(bytesPerSecond('audio/pcma', 24_000), 8000)
    })

    it('returns undefined rather than guessing for an unknown format or rate', () => {
      assert.strictEqual(bytesPerSecond('audio/wav', 24_000), undefined)
      assert.strictEqual(bytesPerSecond('', 24_000), undefined)
      assert.strictEqual(bytesPerSecond('audio/pcm', 0), undefined)
    })
  })

  describe('segmentDurationMs', () => {
    it('derives duration from the byte count', () => {
      assert.strictEqual(segmentDurationMs(48_000, 'audio/pcm', 24_000), 1000)
      assert.strictEqual(segmentDurationMs(480, 'audio/pcm', 24_000), 10)
      assert.strictEqual(segmentDurationMs(8000, 'audio/pcmu', 24_000), 1000)
    })

    it('is fractional below a millisecond rather than rounded away', () => {
      assert.strictEqual(segmentDurationMs(2, 'audio/pcm', 24_000), 2 / 48)
    })

    it('returns undefined for no audio or an unknown format', () => {
      assert.strictEqual(segmentDurationMs(0, 'audio/pcm', 24_000), undefined)
      assert.strictEqual(segmentDurationMs(-1, 'audio/pcm', 24_000), undefined)
      assert.strictEqual(segmentDurationMs(480, 'audio/wav', 24_000), undefined)
    })
  })
})
