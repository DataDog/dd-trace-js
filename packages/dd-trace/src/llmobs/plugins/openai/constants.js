'use strict'

const { EVP_EVENT_SIZE_LIMIT } = require('../../constants/writers')

const INPUT_TYPE_IMAGE = 'input_image'
const INPUT_TYPE_FILE = 'input_file'
const INPUT_TYPE_TEXT = 'input_text'

const IMAGE_FALLBACK = '[image]'
const FILE_FALLBACK = '[file]'
const AUDIO_FALLBACK = '[audio]'
const IMAGE_TOO_LARGE_FALLBACK = '[image omitted: too large]'

// A single inline image may take at most 80% of the per-event budget. An image past this on its own
// would push the event over EVP_EVENT_SIZE_LIMIT, and the writer then drops the span's input AND
// output wholesale (`writers/spans.js#_truncateSpanEvent`), losing the prompt text too; a marker
// keeps the message instead. Same 0.8 fraction as dd-trace-py, though the byte value differs because
// this limit is 5 MiB where dd-trace-py's is 5 MB.
//
// This bounds one image, NOT a request: several images that each fit can still exceed the event limit
// together and trigger the same whole-IO drop, and audio parts count toward no budget at all. A
// running per-request budget is the real fix; dd-trace-py has the identical gap (MLOB-6408).
const MAX_IMAGE_CONTENT_BYTES = Math.floor(EVP_EVENT_SIZE_LIMIT * 0.8)

// Longest text we will record for an image we could not capture (a remote URL or a `file_id`). Real
// references are far shorter; anything longer is a payload masquerading as a reference, so it becomes
// a marker rather than being spliced into the message text.
const MAX_IMAGE_REFERENCE_LENGTH = 2048

// OpenAI audio `format` values that don't map cleanly to `audio/<format>`.
const AUDIO_MIME_TYPES = {
  mp3: 'audio/mpeg',
}

module.exports = {
  INPUT_TYPE_IMAGE,
  INPUT_TYPE_FILE,
  INPUT_TYPE_TEXT,
  IMAGE_FALLBACK,
  IMAGE_TOO_LARGE_FALLBACK,
  MAX_IMAGE_CONTENT_BYTES,
  MAX_IMAGE_REFERENCE_LENGTH,
  FILE_FALLBACK,
  AUDIO_FALLBACK,
  AUDIO_MIME_TYPES,
}
