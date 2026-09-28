'use strict'

module.exports = {
  ERROR_NAMES: {
    API: 'PromptAPIError',
    AUTH: 'PromptAuthError',
    CONFLICT: 'PromptConflictError',
    NOT_FOUND: 'PromptNotFoundError',
    SERVER: 'PromptServerError',
    VALIDATION: 'PromptValidationError',
  },
  PROMPTS_PATH: '/api/unstable/llm-obs/v1/prompts',
  SOURCE_CACHE: 'cache',
}
