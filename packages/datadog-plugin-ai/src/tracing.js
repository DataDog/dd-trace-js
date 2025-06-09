'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

const { channel } = require('dc-polyfill')
const spanFinishCh = channel('dd-trace:otel:span:finish')

const { isVercelAISpan } = require('./util')

// filter input/output based tags for APM spans
// this is for data access controls and for sensitive data
// the LLM Observability feature is recommended in its place for better
// data access controls and sensitive data scrubbing
const TAG_PATTERNS_TO_FILTER = [
  'prompt', // TODO(sabrenner): we need to refine this so it doesn't filter out prompt tokens
  'messages',
  'response.text',
  'toolCalls',
  'toolCall.args',
  'toolCall.result',
  'values',
  'embedding'
]

/**
 * Determines if an OpenTelemetry span tag should be filtered out on the final DD span
 *
 * @param {String} key
 * @returns {Boolean}
 */
function shouldFilterTag (key) {
  return TAG_PATTERNS_TO_FILTER.some(pattern => key.includes(pattern))
}

class VercelAITracingPlugin extends Plugin {
  static get id () { return 'ai' }

  constructor (...args) {
    super(...args)

    spanFinishCh.subscribe(({ ddSpan }) => {
      if (!isVercelAISpan(ddSpan)) {
        return
      }

      for (const key of Object.keys(ddSpan.context()._tags)) {
        if (shouldFilterTag(key)) {
          ddSpan.setTag(key, undefined)
        }
      }
    })
  }
}

module.exports = VercelAITracingPlugin
