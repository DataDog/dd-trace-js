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
    return text.substring(0, limit) + '...'
  }

  return text
}

function isPromptCompletionSampled (sampler) {
  return sampler.isSampled()
}

module.exports = function (integration, tracerConfig) {
  const integrationConfig = tracerConfig[integration]
  const { spanCharLimit, spanPromptCompletionSampleRate } = integrationConfig

  const sampler = new Sampler(spanPromptCompletionSampleRate)

  return {
    normalize: str => normalize(str, spanCharLimit),
    isPromptCompletionSampled: () => isPromptCompletionSampled(sampler)
  }
}
