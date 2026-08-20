'use strict'

const assert = require('node:assert/strict')
const {
  extractContentParts,
  extractResponseInputContent,
  getOpenAIModelProvider,
} = require('../../src/llmobs/plugins/openai/utils')
const OpenAiLLMObsPlugin = require('../../src/llmobs/plugins/openai')
const { MAX_IMAGE_CONTENT_BYTES, MAX_IMAGE_REFERENCE_LENGTH } = require('../../src/llmobs/plugins/openai/constants')
const { UNKNOWN_MODEL_PROVIDER } = require('../../src/llmobs/constants/tags')
const { EVP_EVENT_SIZE_LIMIT } = require('../../src/llmobs/constants/writers')

const PNG_B64 = 'iVBORw0KGgo='
const PNG_DATA_URI = `data:image/png;base64,${PNG_B64}`
const REMOTE_URL = 'https://raw.githubusercontent.com/github/explore/main/topics/python/python.png'

describe('getOpenAIModelProvider', () => {
  it('returns openai for openai.com URLs', () => {
    assert.strictEqual(getOpenAIModelProvider('https://api.openai.com/v1'), 'openai')
  })

  it('returns azure_openai for Azure URLs', () => {
    assert.strictEqual(
      getOpenAIModelProvider('https://my-resource.openai.azure.com/openai'),
      'azure_openai'
    )
  })

  it('returns deepseek for DeepSeek URLs', () => {
    assert.strictEqual(getOpenAIModelProvider('https://api.deepseek.com/v1'), 'deepseek')
  })

  it('returns unknown provider for unrecognised URLs', () => {
    assert.strictEqual(getOpenAIModelProvider('http://127.0.0.1:9126/vcr/proxy'), UNKNOWN_MODEL_PROVIDER)
  })

  it('defaults to unknown provider for an empty string', () => {
    assert.strictEqual(getOpenAIModelProvider(''), UNKNOWN_MODEL_PROVIDER)
  })
})

describe('extractContentParts', () => {
  it('captures an inline base64 image and leaves no text marker', () => {
    assert.deepStrictEqual(
      extractContentParts([
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: PNG_DATA_URI } },
      ]),
      {
        content: 'What is in this image?',
        audioParts: [],
        imageParts: [{ mimeType: 'image/png', content: PNG_B64 }],
      }
    )
  })

  it('accepts a bare-string image_url as well as the documented { url } shape', () => {
    assert.deepStrictEqual(
      extractContentParts([{ type: 'image_url', image_url: PNG_DATA_URI }]),
      { content: '', audioParts: [], imageParts: [{ mimeType: 'image/png', content: PNG_B64 }] }
    )
  })

  it('keeps the [image] marker for a remote URL', () => {
    assert.deepStrictEqual(
      extractContentParts([
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: REMOTE_URL } },
      ]),
      { content: 'What is in this image?\n[image]', audioParts: [], imageParts: [] }
    )
  })

  it('captures several images from one message independently', () => {
    assert.deepStrictEqual(
      extractContentParts([
        { type: 'image_url', image_url: { url: PNG_DATA_URI } },
        { type: 'text', text: 'and' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
      ]),
      {
        content: 'and',
        audioParts: [],
        imageParts: [
          { mimeType: 'image/png', content: PNG_B64 },
          { mimeType: 'image/jpeg', content: '/9j/4AAQ' },
        ],
      }
    )
  })

  it('captures audio and image parts from the same message independently', () => {
    assert.deepStrictEqual(
      extractContentParts([
        { type: 'image_url', image_url: { url: PNG_DATA_URI } },
        { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } },
      ]),
      {
        content: '',
        audioParts: [{ mimeType: 'audio/wav', content: 'aGVsbG8=' }],
        imageParts: [{ mimeType: 'image/png', content: PNG_B64 }],
      }
    )
  })

  it('captures an image exactly at the size cap', () => {
    const content = 'A'.repeat(MAX_IMAGE_CONTENT_BYTES)
    assert.deepStrictEqual(
      extractContentParts([{ type: 'image_url', image_url: { url: `data:image/png;base64,${content}` } }]),
      { content: '', audioParts: [], imageParts: [{ mimeType: 'image/png', content }] }
    )
  })

  it('replaces an image one byte over the size cap with a marker', () => {
    const content = 'A'.repeat(MAX_IMAGE_CONTENT_BYTES + 1)
    assert.deepStrictEqual(
      extractContentParts([
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${content}` } },
      ]),
      { content: 'describe this\n[image omitted: too large]', audioParts: [], imageParts: [] }
    )
  })

  it('keeps the [image] marker for a malformed data URI rather than emitting the payload', () => {
    assert.deepStrictEqual(
      extractContentParts([{ type: 'image_url', image_url: { url: 'data:image/png,notbase64' } }]),
      { content: '[image]', audioParts: [], imageParts: [] }
    )
  })

  it('keeps the [image] marker when image_url is missing entirely', () => {
    assert.deepStrictEqual(
      extractContentParts([{ type: 'image_url' }]),
      { content: '[image]', audioParts: [], imageParts: [] }
    )
  })
})

describe('extractResponseInputContent', () => {
  it('captures an inline base64 image from an input_image part', () => {
    assert.deepStrictEqual(
      extractResponseInputContent([
        { type: 'input_text', text: 'What is in this image?' },
        { type: 'input_image', image_url: PNG_DATA_URI },
      ]),
      { content: 'What is in this image?', imageParts: [{ mimeType: 'image/png', content: PNG_B64 }] }
    )
  })

  it('records a remote URL as a text reference, unchanged from before', () => {
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', image_url: REMOTE_URL }]),
      { content: REMOTE_URL, imageParts: [] }
    )
  })

  it('records a file_id reference as text', () => {
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', file_id: 'file-abc123' }]),
      { content: 'file-abc123', imageParts: [] }
    )
  })

  it('joins text with no separator', () => {
    assert.deepStrictEqual(
      extractResponseInputContent([
        { type: 'input_text', text: 'a' },
        { type: 'input_text', text: 'b' },
      ]),
      { content: 'ab', imageParts: [] }
    )
  })

  it('replaces an oversized inline image with a marker instead of splicing it into the text', () => {
    const content = 'A'.repeat(MAX_IMAGE_CONTENT_BYTES + 1)
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', image_url: `data:image/png;base64,${content}` }]),
      { content: '[image omitted: too large]', imageParts: [] }
    )
  })

  it('captures an image-only message, which carries no text at all', () => {
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', image_url: PNG_DATA_URI }]),
      { content: '', imageParts: [{ mimeType: 'image/png', content: PNG_B64 }] }
    )
  })

  // Regression: an unparseable data URI used to fall through to `extractTextFromContentItem`, which
  // returns the raw `image_url`. That spliced the entire base64 payload into the message text,
  // uncapped — the exact leak the marker exists to prevent. One case per way the parse can fail.
  for (const [name, url] of [
    ['percent-encoded, not base64', 'data:image/svg+xml,%3Csvg%2F%3E'],
    ['no comma', 'data:image/png;base64'],
    ['no media type', 'data:;base64,aGVsbG8='],
    ['non-image media type', 'data:text/plain;base64,aGVsbG8='],
    ['empty payload', 'data:image/png;base64,'],
  ]) {
    it(`marks an unparseable data URI (${name}) instead of emitting it verbatim`, () => {
      assert.deepStrictEqual(
        extractResponseInputContent([{ type: 'input_image', image_url: url }]),
        { content: '[image]', imageParts: [] }
      )
    })
  }

  it('captures a data URI whose scheme or base64 marker is uppercase', () => {
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', image_url: `DATA:image/png;BASE64,${PNG_B64}` }]),
      { content: '', imageParts: [{ mimeType: 'image/png', content: PNG_B64 }] }
    )
  })

  // Recognising a malformed data URI is not enough on its own: a payload that merely fails to look
  // like one still has to be kept out of the text. Bounding the reference length is what guarantees
  // that, so these are the near-miss spellings that would otherwise be spliced in whole.
  for (const [name, imageUrl] of [
    ['a leading space', ` data:image/png;base64,${'A'.repeat(4096)}`],
    ['a leading newline', `\ndata:image/png;base64,${'A'.repeat(4096)}`],
    ['an array that string-coerces', [`data:image/png;base64,${'A'.repeat(4096)}`]],
    ['no scheme at all', 'A'.repeat(4096)],
  ]) {
    it(`marks an over-long reference with ${name} instead of recording it`, () => {
      assert.deepStrictEqual(
        extractResponseInputContent([{ type: 'input_image', image_url: imageUrl }]),
        { content: '[image]', imageParts: [] }
      )
    })
  }

  it('records a reference at the length bound and marks the first one over', () => {
    const atBound = `https://example.com/${'a'.repeat(MAX_IMAGE_REFERENCE_LENGTH - 20)}`
    assert.strictEqual(atBound.length, MAX_IMAGE_REFERENCE_LENGTH)
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', image_url: atBound }]),
      { content: atBound, imageParts: [] }
    )
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', image_url: atBound + 'a' }]),
      { content: '[image]', imageParts: [] }
    )
  })

  it('keeps alt text on an input_image and captures the image alongside it', () => {
    // Off-schema but seen in the wild. Previously the text and the image each dropped the other.
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', text: 'ALT', image_url: PNG_DATA_URI }]),
      { content: 'ALT', imageParts: [{ mimeType: 'image/png', content: PNG_B64 }] }
    )
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', text: 'ALT', image_url: REMOTE_URL }]),
      { content: 'ALT', imageParts: [] }
    )
  })

  it('rejects a multi-byte payload that would pass a UTF-16 length check', () => {
    // 'é' is one UTF-16 unit but two bytes, so a `.length` cap would admit twice the byte budget.
    const payload = 'é'.repeat(MAX_IMAGE_CONTENT_BYTES)
    assert.strictEqual(payload.length, MAX_IMAGE_CONTENT_BYTES)
    assert.deepStrictEqual(
      extractResponseInputContent([{ type: 'input_image', image_url: `data:image/png;base64,${payload}` }]),
      { content: '[image omitted: too large]', imageParts: [] }
    )
  })
})

describe('MAX_IMAGE_CONTENT_BYTES', () => {
  it('is 80% of the per-event size limit', () => {
    // Pinned so a change to the fraction or to EVP_EVENT_SIZE_LIMIT is a deliberate, visible edit —
    // the cap tests above import the constant, so they alone would not catch a drift.
    assert.strictEqual(MAX_IMAGE_CONTENT_BYTES, Math.floor(EVP_EVENT_SIZE_LIMIT * 0.8))
    assert.strictEqual(MAX_IMAGE_CONTENT_BYTES, 4 * 1024 * 1024)
  })
})

describe('OpenAiLLMObsPlugin#_getModelProviderAndClient', () => {
  const call = (baseUrl) => OpenAiLLMObsPlugin.prototype._getModelProviderAndClient(baseUrl)

  it('maps Azure URLs to AzureOpenAI', () => {
    assert.deepStrictEqual(
      call('https://my-resource.openai.azure.com/openai'),
      { modelProvider: 'azure_openai', client: 'AzureOpenAI' }
    )
  })

  it('maps DeepSeek URLs to DeepSeek', () => {
    assert.deepStrictEqual(
      call('https://api.deepseek.com/v1'),
      { modelProvider: 'deepseek', client: 'DeepSeek' }
    )
  })

  it('maps openai.com URLs to OpenAI', () => {
    assert.deepStrictEqual(
      call('https://api.openai.com/v1'),
      { modelProvider: 'openai', client: 'OpenAI' }
    )
  })

  it('falls back to OpenAI client for unknown providers', () => {
    assert.deepStrictEqual(
      call('http://127.0.0.1:9126/vcr/proxy'),
      { modelProvider: UNKNOWN_MODEL_PROVIDER, client: 'OpenAI' }
    )
  })

  it('defaults baseUrl to empty string', () => {
    assert.deepStrictEqual(
      OpenAiLLMObsPlugin.prototype._getModelProviderAndClient(),
      { modelProvider: UNKNOWN_MODEL_PROVIDER, client: 'OpenAI' }
    )
  })
})
