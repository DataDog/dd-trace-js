'use strict'

const INPUT_TYPE_IMAGE = 'input_image'
const INPUT_TYPE_FILE = 'input_file'
const INPUT_TYPE_TEXT = 'input_text'

const IMAGE_FALLBACK = '[image]'
const FILE_FALLBACK = '[file]'
const AUDIO_FALLBACK = '[audio]'

// OpenAI audio `format` values that don't map cleanly to `audio/<format>`.
const AUDIO_MIME_TYPES = {
  mp3: 'audio/mpeg',
}

module.exports = {
  INPUT_TYPE_IMAGE,
  INPUT_TYPE_FILE,
  INPUT_TYPE_TEXT,
  IMAGE_FALLBACK,
  FILE_FALLBACK,
  AUDIO_FALLBACK,
  AUDIO_MIME_TYPES,
}
