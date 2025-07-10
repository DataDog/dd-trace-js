'use strict'

const Sampler = require('../../sampler')

const RE_NEWLINE = /\n/g
const RE_TAB = /\t/g

function normalize (text, limit = 128) {
  if (typeof text !== 'string' || text.length === 0) return

  if (text.length > limit) {
    return text.slice(0, limit) + '...'
  }

  text = text
    .replaceAll(RE_NEWLINE, String.raw`\n`)
    .replaceAll(RE_TAB, String.raw`\t`)

  // In case the replace above matched, more characters were added that must now be considered.
  if (text.length > limit) {
    return text.slice(0, limit) + '...'
  }

  return text
}

/**
 * Determines whether a prompt completion should be sampled based on the configured sampling rate.
 *
 * @param {Sampler} sampler
 * @param {import('index').Span|import('index').SpanContext} span
 * @returns {boolean} `true` if the prompt completion should be sampled, otherwise `false`.
 */
function isPromptCompletionSampled (sampler, span) {
  return sampler.isSampled(span)
}

module.exports = function makeUtilities (integrationName, tracerConfig) {
  const integrationConfig = tracerConfig[integrationName] || {}
  const { spanCharLimit, spanPromptCompletionSampleRate } = integrationConfig

  const sampler = new Sampler(spanPromptCompletionSampleRate ?? 1)

  return {
    normalize: str => normalize(str, spanCharLimit),
    /**
     * Determines whether a prompt completion should be sampled based on the configured sampling rate.
     *
     * @param {import('index').Span|import('index').SpanContext} span
     * @returns {boolean} `true` if the prompt completion should be sampled, otherwise `false`.
     */
    isPromptCompletionSampled: (span) => isPromptCompletionSampled(sampler, span)
  }
}
