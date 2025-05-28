const Sampler = require('../../sampler')

const RE_NEWLINE = /\n/g
const RE_TAB = /\t/g

function normalize (text, limit = 128) {
  if (!text) return
  if (typeof text !== 'string' || !text || (typeof text === 'string' && text.length === 0)) return

  text = text
    .replace(RE_NEWLINE, '\\n')
    .replace(RE_TAB, '\\t')

  if (text.length > limit) {
    return text.slice(0, limit) + '...'
  }

  return text
}

/**
 * Determines whether a prompt completion should be sampled based on the configured sampling rate.
 *
 * @param {Sampler} sampler
 * @param {Span} span
 * @returns {boolean} `true` if the prompt completion should be sampled, otherwise `false`.
 */
function isPromptCompletionSampled (sampler, span) {
  return sampler.isSampled(span)
}

module.exports = function (integrationName, tracerConfig) {
  const integrationConfig = tracerConfig[integrationName] || {}
  const { spanCharLimit, spanPromptCompletionSampleRate } = integrationConfig

  const sampler = new Sampler(spanPromptCompletionSampleRate ?? 1.0)

  return {
    normalize: str => normalize(str, spanCharLimit),
    /**
     * Determines whether a prompt completion should be sampled based on the configured sampling rate.
     *
     * @param {Span} span
     * @returns {boolean} `true` if the prompt completion should be sampled, otherwise `false`.
     */
    isPromptCompletionSampled: (span) => isPromptCompletionSampled(sampler, span)
  }
}
