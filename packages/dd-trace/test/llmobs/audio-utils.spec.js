'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  audioMimeTypeFromFormat,
  formatAudioPart,
  formatAudioPartWithGuard,
  isRenderableAudioMime,
} = require('../../src/llmobs/audio-utils')
const { LLMOBS_AUDIO_INLINE_MAX_BYTES } = require('../../src/llmobs/constants/audio')

describe('audio-utils', () => {
  describe('audioMimeTypeFromFormat', () => {
    it('maps a format to audio/<format> by default', () => {
      assert.strictEqual(audioMimeTypeFromFormat('wav'), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat('opus'), 'audio/opus')
      assert.strictEqual(audioMimeTypeFromFormat('mp3'), 'audio/mp3')
    })

    it('prefers a provider override from mimeTypeLookup', () => {
      assert.strictEqual(audioMimeTypeFromFormat('mp3', { mp3: 'audio/mpeg' }), 'audio/mpeg')
      assert.strictEqual(audioMimeTypeFromFormat('wav', { mp3: 'audio/mpeg' }), 'audio/wav')
    })

    it('normalizes whitespace and case', () => {
      assert.strictEqual(audioMimeTypeFromFormat('  MP3 ', { mp3: 'audio/mpeg' }), 'audio/mpeg')
      assert.strictEqual(audioMimeTypeFromFormat('WAV'), 'audio/wav')
    })

    it('defaults to audio/wav for missing or non-string formats', () => {
      assert.strictEqual(audioMimeTypeFromFormat(''), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat('   '), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat(undefined), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat(5), 'audio/wav')
    })

    it('does not resolve a format off Object.prototype', () => {
      assert.strictEqual(audioMimeTypeFromFormat('constructor', { mp3: 'audio/mpeg' }), 'audio/constructor')
      assert.strictEqual(audioMimeTypeFromFormat('__proto__', { mp3: 'audio/mpeg' }), 'audio/__proto__')
    })
  })

  describe('formatAudioPart', () => {
    it('passes through an existing base64 string', () => {
      assert.deepStrictEqual(
        formatAudioPart('aGVsbG8=', 'audio/wav'),
        { mimeType: 'audio/wav', content: 'aGVsbG8=' }
      )
    })

    it('base64-encodes Buffer and Uint8Array input', () => {
      const expected = Buffer.from('hello').toString('base64')
      assert.deepStrictEqual(
        formatAudioPart(Buffer.from('hello'), 'audio/mpeg'),
        { mimeType: 'audio/mpeg', content: expected }
      )
      assert.deepStrictEqual(
        formatAudioPart(new Uint8Array([104, 101, 108, 108, 111]), 'audio/mpeg'),
        { mimeType: 'audio/mpeg', content: expected }
      )
    })

    it('passes through non-binary, non-string input unchanged (tagger soft-skips it)', () => {
      const result = formatAudioPart(5, 'audio/wav')
      assert.deepStrictEqual(result, { mimeType: 'audio/wav', content: 5 })
    })
  })

  describe('isRenderableAudioMime', () => {
    it('accepts container formats the UI can play', () => {
      assert.strictEqual(isRenderableAudioMime('audio/wav'), true)
      assert.strictEqual(isRenderableAudioMime('audio/mpeg'), true)
      assert.strictEqual(isRenderableAudioMime(' AUDIO/WAV '), true)
    })

    it('rejects raw and companded formats that have no container', () => {
      for (const mime of [
        'audio/pcm', 'audio/pcm16', 'audio/l16',
        'audio/pcmu', 'audio/pcma', 'audio/g711_ulaw', 'audio/g711_alaw', 'audio/basic',
      ]) {
        assert.strictEqual(isRenderableAudioMime(mime), false, mime)
      }
    })

    it('rejects a missing MIME type', () => {
      assert.strictEqual(isRenderableAudioMime(''), false)
      assert.strictEqual(isRenderableAudioMime(undefined), false)
    })
  })

  describe('formatAudioPartWithGuard', () => {
    it('builds a part for a renderable format within budget', () => {
      assert.deepStrictEqual(
        formatAudioPartWithGuard(Buffer.from('hello'), 'audio/wav'),
        { mimeType: 'audio/wav', content: Buffer.from('hello').toString('base64') }
      )
    })

    it('omits a part for a non-renderable format', () => {
      assert.strictEqual(formatAudioPartWithGuard(Buffer.from('hello'), 'audio/pcm'), undefined)
    })

    it('omits a part for empty or missing audio', () => {
      assert.strictEqual(formatAudioPartWithGuard(Buffer.alloc(0), 'audio/wav'), undefined)
      assert.strictEqual(formatAudioPartWithGuard(undefined, 'audio/wav'), undefined)
    })

    // The budget is measured on the base64-encoded size, which is what rides the span event, so the
    // boundary sits at 3/4 of maxBytes of raw audio. Pin both sides of it.
    it('accepts audio whose encoded size is exactly the budget and rejects one byte more', () => {
      const maxBytes = 400
      const exact = Buffer.alloc(maxBytes / 4 * 3) // 300 raw bytes -> exactly 400 encoded
      const overBy = Buffer.alloc(exact.length + 1) // 301 raw bytes -> 404 encoded

      assert.notStrictEqual(formatAudioPartWithGuard(exact, 'audio/wav', maxBytes), undefined)
      assert.strictEqual(formatAudioPartWithGuard(overBy, 'audio/wav', maxBytes), undefined)
    })

    it('defaults the budget to the inline maximum', () => {
      const raw = Buffer.alloc(LLMOBS_AUDIO_INLINE_MAX_BYTES / 4 * 3)
      assert.notStrictEqual(formatAudioPartWithGuard(raw, 'audio/wav'), undefined)
      assert.strictEqual(formatAudioPartWithGuard(Buffer.alloc(raw.length + 3), 'audio/wav'), undefined)
    })
  })
})
