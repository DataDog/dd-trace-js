'use strict'

// Input types (must match Python: ddtrace/llmobs/_constants.py)
const INPUT_TYPE_IMAGE = 'input_image'
const INPUT_TYPE_FILE = 'input_file'
const INPUT_TYPE_TEXT = 'input_text'

// Prompt tracking tags (must match Python: ddtrace/llmobs/_constants.py)
const PROMPT_TRACKING_INSTRUMENTATION_METHOD = 'prompt_tracking_instrumentation_method'
const PROMPT_MULTIMODAL = 'prompt_multimodal'

// Instrumentation methods
const INSTRUMENTATION_METHOD_AUTO = 'auto'
const INSTRUMENTATION_METHOD_ANNOTATED = 'annotated'
const INSTRUMENTATION_METHOD_UNKNOWN = 'unknown'

// Fallback markers for when values are stripped
const IMAGE_FALLBACK = '[image]'
const FILE_FALLBACK = '[file]'

module.exports = {
  // Input types
  INPUT_TYPE_IMAGE,
  INPUT_TYPE_FILE,
  INPUT_TYPE_TEXT,

  // Prompt tracking
  PROMPT_TRACKING_INSTRUMENTATION_METHOD,
  PROMPT_MULTIMODAL,
  INSTRUMENTATION_METHOD_AUTO,
  INSTRUMENTATION_METHOD_ANNOTATED,
  INSTRUMENTATION_METHOD_UNKNOWN,

  // Fallback markers
  IMAGE_FALLBACK,
  FILE_FALLBACK
}
