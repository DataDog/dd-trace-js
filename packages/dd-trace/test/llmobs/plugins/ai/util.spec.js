'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { extractUserContentParts } = require('../../../../src/llmobs/plugins/ai/util')

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const PNG_BASE64 = 'iVBORw0KGgo='

describe('ai llmobs util', () => {
  describe('extractUserContentParts', () => {
    it('captures a v4 image part keyed off mimeType', () => {
      assert.deepStrictEqual(
        extractUserContentParts([{ type: 'image', image: PNG_BASE64, mimeType: 'image/png' }]),
        { content: '', imageParts: [{ mimeType: 'image/png', content: PNG_BASE64 }] }
      )
    })

    it('captures a v5 and v6 file part keyed off mediaType', () => {
      assert.deepStrictEqual(
        extractUserContentParts([{ type: 'file', data: PNG_BASE64, mediaType: 'image/png' }]),
        { content: '', imageParts: [{ mimeType: 'image/png', content: PNG_BASE64 }] }
      )
    })

    it('captures a v7 tagged data part, base64-encoding raw bytes', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'file', data: { type: 'data', data: new Uint8Array(PNG_BYTES) }, mediaType: 'image/png' },
        ]),
        { content: '', imageParts: [{ mimeType: 'image/png', content: PNG_BASE64 }] }
      )
    })

    it('captures a v7 tagged data part that already carries base64', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'file', data: { type: 'data', data: PNG_BASE64 }, mediaType: 'image/jpeg' },
        ]),
        { content: '', imageParts: [{ mimeType: 'image/jpeg', content: PNG_BASE64 }] }
      )
    })

    it('encodes a Buffer and an ArrayBuffer payload', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'file', data: PNG_BYTES, mediaType: 'image/png' },
          { type: 'file', data: new Uint8Array(PNG_BYTES).buffer, mediaType: 'image/png' },
        ]),
        {
          content: '',
          imageParts: [
            { mimeType: 'image/png', content: PNG_BASE64 },
            { mimeType: 'image/png', content: PNG_BASE64 },
          ],
        }
      )
    })

    it('keeps text around a captured image without inserting a marker', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'text', text: 'before' },
          { type: 'file', data: PNG_BASE64, mediaType: 'image/png' },
          { type: 'text', text: 'after' },
        ]),
        { content: 'beforeafter', imageParts: [{ mimeType: 'image/png', content: PNG_BASE64 }] }
      )
    })

    it('captures multiple images from a single message in order', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'file', data: PNG_BASE64, mediaType: 'image/png' },
          { type: 'text', text: 'and' },
          { type: 'file', data: { type: 'data', data: PNG_BASE64 }, mediaType: 'image/webp' },
        ]),
        {
          content: 'and',
          imageParts: [
            { mimeType: 'image/png', content: PNG_BASE64 },
            { mimeType: 'image/webp', content: PNG_BASE64 },
          ],
        }
      )
    })

    it('marks a remote URL that arrived as a stringified field', () => {
      assert.deepStrictEqual(
        extractUserContentParts([{ type: 'file', data: 'https://example.com/cat.png', mediaType: 'image/png' }]),
        { content: '[Image]', imageParts: [] }
      )
    })

    it('marks a URL instance', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'file', data: new URL('https://example.com/cat.png'), mediaType: 'image/png' },
        ]),
        { content: '[Image]', imageParts: [] }
      )
    })

    it('marks the v7 payload variants that carry no bytes', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'file', data: { type: 'url', url: new URL('https://example.com/cat.png') }, mediaType: 'image/png' },
          { type: 'file', data: { type: 'reference', reference: { openai: 'file-123' } }, mediaType: 'image/png' },
          { type: 'file', data: { type: 'text', text: 'not an image' }, mediaType: 'image/png' },
        ]),
        { content: '[Image][Image][Image]', imageParts: [] }
      )
    })

    it('marks an image whose media type carries no renderable subtype', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'file', data: PNG_BASE64, mediaType: 'image' },
          { type: 'file', data: PNG_BASE64, mediaType: 'image/*' },
          { type: 'file', data: PNG_BASE64, mediaType: 'image/' },
          { type: 'image', image: PNG_BASE64 },
        ]),
        { content: '[Image][Image][Image][Image]', imageParts: [] }
      )
    })

    it('leaves non-image files unrepresented', () => {
      assert.deepStrictEqual(
        extractUserContentParts([
          { type: 'text', text: 'see' },
          { type: 'file', data: PNG_BASE64, mediaType: 'application/pdf' },
        ]),
        { content: 'see', imageParts: [] }
      )
    })

    it('tolerates malformed parts without throwing', () => {
      // Only the two parts that identify as an image but yield no bytes earn a marker. A file part
      // with an unusable mediaType cannot be recognised as an image at all, so it is left alone.
      assert.deepStrictEqual(
        extractUserContentParts([
          null,
          undefined,
          {},
          { type: 'text' },
          { type: 'file', mediaType: 'image/png' },
          { type: 'file', data: PNG_BASE64, mediaType: 42 },
          { type: 'image', image: 12345, mimeType: 'image/png' },
          { type: 'unknown-part', data: PNG_BASE64 },
        ]),
        { content: '[Image][Image]', imageParts: [] }
      )
    })

    it('passes a plain string content through unchanged', () => {
      assert.deepStrictEqual(
        extractUserContentParts('just text'),
        { content: 'just text', imageParts: [] }
      )
    })

    it('returns empty content for a content shape that is neither array nor string', () => {
      assert.deepStrictEqual(extractUserContentParts(undefined), { content: '', imageParts: [] })
      assert.deepStrictEqual(extractUserContentParts({ type: 'file' }), { content: '', imageParts: [] })
    })
  })
})
