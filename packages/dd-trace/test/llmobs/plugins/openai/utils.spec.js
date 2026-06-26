'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { extractContentParts } = require('../../../../src/llmobs/plugins/openai/utils')

describe('openai llmobs utils', () => {
  describe('extractContentParts', () => {
    it('concatenates text parts and collapses images to a marker', () => {
      const { content, audioParts } = extractContentParts([
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ])

      assert.strictEqual(content, 'describe this\n[image]')
      assert.deepStrictEqual(audioParts, [])
    })

    it('captures input_audio with data as a structured audio part (no marker)', () => {
      const { content, audioParts } = extractContentParts([
        { type: 'text', text: 'what is this' },
        { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'mp3' } },
      ])

      assert.strictEqual(content, 'what is this')
      assert.deepStrictEqual(audioParts, [{ mimeType: 'audio/mpeg', content: 'aGVsbG8=' }])
    })

    it('falls back to an [audio] marker when input_audio has no data', () => {
      const { content, audioParts } = extractContentParts([
        { type: 'text', text: 'transcribe' },
        { type: 'input_audio', input_audio: { format: 'wav' } },
      ])

      assert.strictEqual(content, 'transcribe\n[audio]')
      assert.deepStrictEqual(audioParts, [])
    })

    it('captures multiple audio parts and defaults the mime type from format', () => {
      const { content, audioParts } = extractContentParts([
        { type: 'input_audio', input_audio: { data: 'AAAA' } },
        { type: 'input_audio', input_audio: { data: 'BBBB', format: 'wav' } },
      ])

      assert.strictEqual(content, '')
      assert.deepStrictEqual(audioParts, [
        { mimeType: 'audio/wav', content: 'AAAA' },
        { mimeType: 'audio/wav', content: 'BBBB' },
      ])
    })

    it('renders unknown part types as a bracketed marker', () => {
      const { content, audioParts } = extractContentParts([
        { type: 'text', text: 'hi' },
        { type: 'file', file: { file_id: 'file-123' } },
      ])

      assert.strictEqual(content, 'hi\n[file]')
      assert.deepStrictEqual(audioParts, [])
    })
  })
})
