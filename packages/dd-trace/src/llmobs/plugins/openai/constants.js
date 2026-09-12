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

const COMMON_METADATA_KEYS = new Set([
  'stream',
  'temperature',
  'top_p',
  'user',
])

const OPENAI_METADATA_RESPONSE_KEYS = new Set([
  'background',
  'include',
  'max_output_tokens',
  'max_tool_calls',
  'parallel_tool_calls',
  'previous_response_id',
  'prompt',
  'reasoning',
  'service_tier',
  'store',
  'text',
  'tool_choice',
  'top_logprobs',
  'truncation',
])

const OPENAI_METADATA_CHAT_KEYS = new Set([
  'audio',
  'frequency_penalty',
  'function_call',
  'logit_bias',
  'logprobs',
  'max_completion_tokens',
  'max_tokens',
  'modalities',
  'n',
  'parallel_tool_calls',
  'prediction',
  'presence_penalty',
  'reasoning_effort',
  'response_format',
  'seed',
  'service_tier',
  'stop',
  'store',
  'stream_options',
  'tool_choice',
  'top_logprobs',
  'web_search_options',
])

const OPENAI_METADATA_COMPLETION_KEYS = new Set([
  'best_of',
  'echo',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'max_tokens',
  'n',
  'presence_penalty',
  'seed',
  'stop',
  'stream_options',
  'suffix',
])

module.exports = {
  INPUT_TYPE_IMAGE,
  INPUT_TYPE_FILE,
  INPUT_TYPE_TEXT,
  IMAGE_FALLBACK,
  FILE_FALLBACK,
  AUDIO_FALLBACK,
  AUDIO_MIME_TYPES,
  COMMON_METADATA_KEYS,
  OPENAI_METADATA_RESPONSE_KEYS,
  OPENAI_METADATA_CHAT_KEYS,
  OPENAI_METADATA_COMPLETION_KEYS,
}
