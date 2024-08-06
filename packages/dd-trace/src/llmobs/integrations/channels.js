'use strict'

const { channel } = require('dc-polyfill')

module.exports = {
  llmobsSpanStartCh: channel('dd-trace:llmobs:span:start'),
  llmobsSpanEndCh: channel('dd-trace:llmobs:span:end'),
  llmobsSpanErrorCh: channel('dd-trace:llmobs:span:error')
}
